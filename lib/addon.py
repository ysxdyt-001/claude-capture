"""
mitmproxy addon：把 Claude Code 与 Anthropic 兼容端点之间的通信
（request body + 完整 SSE response）落盘为 JSON。

captures 目录由环境变量 CLAUDE_CAPTURE_DIR 指定（由 claude-capture CLI 注入）。
默认回退到 ./captures/，方便直接用 mitmweb -s addon.py 单独调试。

文件结构：
  {
    "timestamp": "...",
    "id": "<mitmproxy flow id>",
    "request": { "method", "url", "headers", "body" },
    "response": {
      "status_code", "headers", "content_type",
      "sse_events": [...]   # 流式响应
      | "body": ...          # 非流式响应
    }
  }
"""
from __future__ import annotations

import json
import os
import re
import time
from datetime import datetime
from pathlib import Path

from mitmproxy import http

# 抓取的路径关键词：Anthropic /messages（v1/messages、v1/messages/batches 等）
# 以及 OpenAI 的 /chat/completions 与 /completions。
TARGET_PATH_KEYWORDS = ("/messages", "/chat/completions", "/completions")


def _matches(path: str) -> bool:
    return any(kw in path for kw in TARGET_PATH_KEYWORDS)

# captures 目录：优先读环境变量，回退到 ./captures/
CAPTURES_DIR = Path(os.environ.get("CLAUDE_CAPTURE_DIR", "./captures")).expanduser().resolve()

# Claude Code 在请求头里带的 session id（UUID），用来给 capture 分目录。
SESSION_HEADER = "x-claude-code-session-id"

# 进程级 fallback 目录：请求没带 session header 时落到这里。
# 用「一次 mitmweb 进程」做兜底，避免所有无 header 的散包混在同一个桶里。
_FALLBACK_DIR = CAPTURES_DIR / f"session-{datetime.now().strftime('%Y%m%d-%H%M%S')}-{os.getpid()}"

# 只保留 UUID / 文件名安全字符，其余替换成 _。防 path traversal 与怪异目录名。
_SAFE_CHARS = re.compile(r"[^A-Za-z0-9._-]")


def _session_dir_for(flow: http.HTTPFlow) -> Path:
    """按请求里的 X-Claude-Code-Session-Id 选目录；缺失/非法时回退到进程级目录。"""
    sid = flow.request.headers.get(SESSION_HEADER)
    if sid:
        cleaned = _SAFE_CHARS.sub("_", sid).strip("._")[:128]
        if cleaned:
            return CAPTURES_DIR / cleaned
    return _FALLBACK_DIR


def _safe_json(text: str):
    """尝试解析为 JSON，失败则返回原始字符串。"""
    try:
        return json.loads(text)
    except Exception:
        return text


def _parse_sse(text: str):
    """把 SSE 文本流拆成 [{event, data}] 列表。"""
    events = []
    for block in text.split("\n\n"):
        block = block.strip()
        if not block:
            continue
        name = None
        data_lines = []
        for line in block.splitlines():
            if line.startswith("event:"):
                name = line[len("event:"):].strip()
            elif line.startswith("data:"):
                data_lines.append(line[len("data:"):].strip())
        if not data_lines:
            continue
        raw = "\n".join(data_lines)
        events.append({"event": name, "data": _safe_json(raw)})
    return events


def request(flow: http.HTTPFlow) -> None:
    """请求一到就触发（不等响应），用于对比请求数 vs 写盘数。"""
    if _matches(flow.request.path):
        print(f"[addon] recv   {flow.request.method} {flow.request.pretty_url}  (waiting response...)", flush=True)


def response(flow: http.HTTPFlow) -> None:
    try:
        path = flow.request.path
        status = flow.response.status_code

        if not _matches(path):
            return

        session_dir = _session_dir_for(flow)
        session_dir.mkdir(parents=True, exist_ok=True)

        ts = datetime.now().strftime("%Y-%m-%d_%H%M%S")
        suffix = f"{ts}-{abs(hash(flow.id)) % 0xFFFF:04x}" if flow.id else ts
        safe_path = flow.request.path.split('?')[0].strip('/').replace('/', '_')
        filename = f"{suffix}_{flow.request.method}_{safe_path}.json"

        req_body = _safe_json(flow.request.get_text() or "")
        resp_text = flow.response.get_text() or ""
        content_type = flow.response.headers.get("content-type", "")

        record = {
            "timestamp": ts,
            "id": flow.id,
            "request": {
                "method": flow.request.method,
                "url": flow.request.pretty_url,
                "headers": dict(flow.request.headers),
                "body": req_body,
            },
            "response": {
                "status_code": flow.response.status_code,
                "headers": dict(flow.response.headers),
                "content_type": content_type,
            },
        }

        if "text/event-stream" in content_type:
            record["response"]["sse_events"] = _parse_sse(resp_text)
        else:
            record["response"]["body"] = _safe_json(resp_text)

        out_path = session_dir / filename
        # 显式 UTF-8：Windows 非 UTF-8 区域（cp936/cp932/cp949 等）默认编码无法
        # 表示 CJK / emoji / 制表符（Claude system prompt 与工具输出里常见），
        # ensure_ascii=False 写出时会抛 UnicodeEncodeError；且 write_text 先 open
        # 截断文件再 write，异常会导致磁盘上残留 0 字节文件。
        out_path.write_text(
            json.dumps(record, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        print(f"[addon] wrote {filename}  ({status}, {len(resp_text)} bytes)", flush=True)
    except Exception as exc:
        print(f"[addon] ERROR on {flow.request.pretty_url}: {exc}", flush=True)
