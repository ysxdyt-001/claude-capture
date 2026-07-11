// 抓包查看服务：扫描 captures 目录并提供 HTTP API + 静态页面。
// 通过 startServer({ capturesDir, port, publicDir }) 启动。
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

// 模块级缓存：进程级，CLI 重启失效。键为文件绝对路径。
// Module-level cache: process-scoped, dies with the CLI. Keyed by absolute file path.
const listCache = new Map();  // full-path -> { mtime, size, item }

async function listCaptures(capturesDir) {
  // 递归扫描 capturesDir，包括 session-* 子目录。返回的 name 是相对路径
  // （如 "session-20260708-143022-1234/xxx.json"），前端直接拼到 /api/file?name=。
  // 缓存命中时复用上次的 ListItem 对象引用 —— 下游 React memo 依赖这个引用稳定性。
  // Recursive scan of capturesDir including session-* subdirs. `name` is the relative path
  // (e.g. "session-20260708-143022-1234/xxx.json") that the frontend appends to /api/file?name=.
  // Cache hits reuse the previous ListItem object reference — downstream React memo relies on this identity.
  const items = [];
  const stack = [""];
  const seen = new Set();

  while (stack.length) {
    const rel = stack.pop();
    const dir = path.join(capturesDir, rel);
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        stack.push(childRel);
        continue;
      }
      if (!ent.name.endsWith(".json")) continue;

      const full = path.join(dir, ent.name);
      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      seen.add(full);

      // 命中：mtime 与 size 都未变 → 复用同一 ListItem 引用（不要展开成新对象！）。
      // Hit: mtime and size unchanged → reuse the same ListItem reference (do NOT spread into a new object!).
      const cached = listCache.get(full);
      if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) {
        items.push(cached.item);
        continue;
      }

      // 未命中：读取并解析。解析失败故意不缓存（下次 poll 重试，让坏文件能自愈）。
      // Miss: read and parse. Parse failures are intentionally NOT cached so bad files self-heal.
      try {
        const raw = await fs.readFile(full, "utf8");
        const data = JSON.parse(raw);
        const lastUser = extractLastUserText(data);
        const item = {
          name: childRel,
          mtime: stat.mtimeMs,
          size: stat.size,
          status: data.response?.status_code,
          preview: lastUser?.slice(0, 80) ?? "(empty)",
          tag: classifyRequest(data),
        };
        listCache.set(full, { mtime: stat.mtimeMs, size: stat.size, item });
        items.push(item);
      } catch {
        items.push({ name: childRel, mtime: 0, size: 0, status: 0, preview: "(parse error)" });
      }
    }
  }

  // 清理已删除文件的缓存项，避免内存泄漏。
  // Drop cache entries for deleted files to avoid memory leaks.
  for (const key of listCache.keys()) {
    if (!seen.has(key)) listCache.delete(key);
  }

  items.sort((a, b) => b.mtime - a.mtime);
  return items;
}

function extractLastUserText(data) {
  const msgs = data?.request?.body?.messages;
  if (!Array.isArray(msgs)) return null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      const texts = m.content
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text);
      if (texts.length) return texts.join("\n");
    }
  }
  return null;
}

// 根据 URL / 系统提示 / 工具数量判定请求来源（主代理 vs 子代理 vs 工具调用）。
// Classify a capture as main-agent / subagent / explore / utility / unknown.
// Signals are consulted in priority order: URL path, system-prompt text, tool count.
function classifyRequest(data) {
  const req = data?.request ?? {};
  const body = req?.body ?? {};

  // Signal 1: URL path —— count_tokens 不是对话，是 token 计数调用。
  // Signal 1: URL path — count_tokens is a token-count call, not a conversation.
  const url = typeof req.url === "string" ? req.url : "";
  if (url.includes("/count_tokens")) return "utility";

  // 归一化 system 字段（字符串或 {type:"text",text}[] 都可能）。
  // Normalize the system field (may be a string or an array of text blocks).
  let systemText = "";
  const sys = body.system;
  if (typeof sys === "string") {
    systemText = sys;
  } else if (Array.isArray(sys)) {
    systemText = sys
      .map((b) => (b && typeof b === "object" && typeof b.text === "string" ? b.text : ""))
      .join("\n");
  }
  const head = systemText.slice(0, 200);

  // Signal 2: 系统提示里的稳定关键字（Claude Code 自己注入的）。
  // Signal 2: stable keywords Claude Code injects into the system prompt.
  if (head.includes("You are an interactive agent")) return "main";
  if (head.includes("You are an agent for Claude Code")) return "subagent";
  if (head.includes("You are a file search specialist for Claude Code")) return "explore";
  if (head.includes("Generate a concise, sentence-case title")) return "utility";

  // Signal 3: 工具数量兜底（应对未来 Claude Code 改动措辞）。
  // Signal 3: tool-count fallback (insurance against future wording drift).
  const tools = Array.isArray(body.tools) ? body.tools.length : 0;
  if (tools >= 22) return "main";
  if (tools >= 1) return "subagent";
  return "unknown";
}

export function startServer({ capturesDir, port, publicDir }) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${port}`);

      if (url.pathname === "/api/files") {
        const items = await listCaptures(capturesDir);
        return json(res, items);
      }

      if (url.pathname === "/api/file") {
        const name = url.searchParams.get("name");
        if (!name) return text(res, "bad name", 400);
        // 允许子目录路径（session-.../xxx.json），但禁止逃出 capturesDir。
        const full = path.resolve(capturesDir, name);
        const underRoot = full === capturesDir || full.startsWith(capturesDir + path.sep);
        if (!underRoot) return text(res, "forbidden", 403);
        const data = await fs.readFile(full, "utf8");
        return text(res, data, 200, "application/json; charset=utf-8");
      }

      // 静态文件：/ → index.html
      let rel = url.pathname === "/" ? "/index.html" : url.pathname;
      const full = path.join(publicDir, rel);
      if (!full.startsWith(publicDir)) return text(res, "forbidden", 403);
      try {
        const body = await fs.readFile(full);
        const mime = MIME[path.extname(full)] ?? "application/octet-stream";
        res.writeHead(200, { "content-type": mime });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end("not found");
      }
    } catch (err) {
      console.error(err);
      res.writeHead(500);
      res.end(String(err));
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}
function text(res, body, status = 200, mime = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": mime });
  res.end(body);
}
