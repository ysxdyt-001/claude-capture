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
        const kind = classifyKind(data);
        const preview = kind === "continuation"
          ? extractAssistantAction(data)
          : extractLastUserText(data);
        const msgs = data?.request?.body?.messages;
        const item = {
          name: childRel,
          mtime: stat.mtimeMs,
          size: stat.size,
          status: data.response?.status_code,
          preview: preview?.slice(0, 80) ?? "(empty)",
          tag: classifyRequest(data),
          kind,
          messageCount: Array.isArray(msgs) ? msgs.length : 0,
        };
        // 服务端内部字段：不可枚举，JSON.stringify 自动跳过，无需手动删除。
        // 这样缓存命中时 __messages 仍然可读，linkSubagents 在后续 poll 仍能收集指纹。
        // Server-internal fields: non-enumerable so JSON.stringify skips them automatically.
        // This preserves __messages on cache hits so linkSubagents can collect fingerprints on subsequent polls.
        Object.defineProperty(item, "__messages", {
          value: msgs,
          enumerable: false,
          writable: true,
          configurable: true,
        });
        // 不可变原始分类 —— detectCompressions 会原地改 kind，但 __originalKind 保持不变，
        // 确保 mainAnchors 过滤在每次 poll 都产生相同的集合（幂等）。
        // Immutable original classification — detectCompressions mutates kind in-place,
        // but __originalKind stays stable so mainAnchors filtering is deterministic across polls.
        Object.defineProperty(item, "__originalKind", {
          value: kind,
          enumerable: false,
          writable: false,
          configurable: false,
        });
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

// 已知工具名 → 取哪个 input 字段作为简短展示。
// Well-known tool names → which input field to show as the brief label.
const TOOL_INPUT_FIELD = {
  Read: "file_path",
  Edit: "file_path",
  Write: "file_path",
  Bash: "command",
  Grep: "pattern",
  Glob: "pattern",
  Agent: "description",
  Task: "description",
  WebFetch: "url",
  WebSearch: "query",
};

// 从 capture 里提取「助手这轮做了什么」作为 continuation 行的 preview。
// 优先展示工具调用（ToolName · 简短参数）；没有工具调用则展示文本回复的片段。
// Extract "what the assistant did this turn" as the preview for continuation rows.
// Prefers tool calls (ToolName · brief arg); falls back to a text-response snippet.
function extractAssistantAction(data) {
  const msgs = data?.request?.body?.messages;
  if (!Array.isArray(msgs)) return null;
  let assistant = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "assistant") { assistant = msgs[i]; break; }
  }
  if (!assistant) return "(no assistant turn)";
  const content = Array.isArray(assistant.content) ? assistant.content : [];

  // 收集 tool_use 块（跳过 thinking 块）。
  // Collect tool_use blocks (skip thinking blocks).
  const toolUses = content.filter(
    (c) => c && typeof c === "object" && c.type === "tool_use"
  );
  if (toolUses.length > 0) {
    const fmtOne = (tu) => {
      const name = tu.name || "tool";
      const field = TOOL_INPUT_FIELD[name];
      let arg = "";
      if (field && tu.input && typeof tu.input === "object" && typeof tu.input[field] === "string") {
        arg = " · " + tu.input[field].slice(0, 40);
      }
      return name + arg;
    };
    const first = fmtOne(toolUses[0]);
    return toolUses.length === 1 ? first : first + " + " + (toolUses.length - 1) + " more";
  }

  // 没有工具调用 —— 取第一条 text 块的片段。
  // No tool calls — snippet the first text block.
  for (const c of content) {
    if (c && typeof c === "object" && c.type === "text" && typeof c.text === "string") {
      const snippet = c.text.replace(/\s+/g, " ").trim().slice(0, 60);
      return '"' + snippet + '..."';
    }
  }
  return "(empty assistant turn)";
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

// 压缩指示短语 —— 出现在首条 user 消息开头时，可能是上下文压缩摘要。
// Compression-indicator phrases — when present at the start of the first user message,
// the capture is likely a post-compaction re-send.
const COMPRESSION_PHRASES = [
  "summary of",
  "previously, on",
  "conversation so far",
  "the user and assistant have been discussing",
];

// 判定一条 capture 是「锚点」（用户真正发了新消息）还是「续轮」（工具结果回填）还是「压缩」（上下文压缩后重发）。
// 用于前端把 capture 聚合成对话：每个 anchor 开启新对话，continuation 追加到当前对话，
// compressed 标记压缩边界。Signal 2/3 在这里检测；Signal 1（跨 capture 的 messageCount 骤降）
// 需要 cross-capture 状态，由 detectCompressions 后续 pass 处理。
// Determine whether a capture is an "anchor" (the user sent a new message), a
// "continuation" (a tool_result feeding back), or "compressed" (a post-compaction re-send).
// The frontend groups captures into conversations using this: each anchor starts a new
// conversation, continuations append, compressed marks a compaction boundary.
// Signals 2/3 are detected here; Signal 1 (cross-capture messageCount drop) needs
// cross-capture state and is handled by detectCompressions in a subsequent pass.
function classifyKind(data) {
  const body = data?.request?.body ?? {};
  const msgs = body.messages;

  // Signal 3: API 字段 —— 未来 Anthropic 若加 is_compact / compacted_until 等字段。
  // Signal 3: API field — if Anthropic later adds is_compact / compacted_until etc.
  if (body && typeof body === "object") {
    for (const k of Object.keys(body)) {
      if (k.toLowerCase().includes("compact")) return "compressed";
    }
  }

  if (!Array.isArray(msgs)) return "anchor";

  // 找最后一条 user 消息，决定 anchor vs continuation（原逻辑保留）。
  // Find the last user message to decide anchor vs continuation (original logic).
  let lastUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user") { lastUserIdx = i; break; }
  }
  if (lastUserIdx === -1) return "anchor";
  const lastUser = msgs[lastUserIdx];
  const lastContent = lastUser.content;
  let lastIsAnchor = false;
  if (typeof lastContent === "string") lastIsAnchor = true;
  else if (Array.isArray(lastContent)) {
    let hasToolResult = false;
    for (const c of lastContent) {
      if (c && typeof c === "object" && c.type === "tool_result") { hasToolResult = true; break; }
    }
    lastIsAnchor = !hasToolResult;
  } else {
    lastIsAnchor = true;
  }

  // Signal 2: 首条 user 消息像压缩摘要 —— 仅当最后一条 user 是 anchor（文本）时才检查。
  // Signal 2: first user message looks like a compaction summary — only check when
  // the last user message is text (anchor-shaped), so we don't misclassify tool flows.
  if (lastIsAnchor) {
    const firstUser = msgs.find((m) => m.role === "user");
    if (firstUser) {
      let firstText = "";
      const fc = firstUser.content;
      if (typeof fc === "string") firstText = fc;
      else if (Array.isArray(fc)) {
        for (const c of fc) {
          if (c && typeof c === "object" && c.type === "text" && typeof c.text === "string") {
            firstText = c.text;
            break;
          }
        }
      }
      const head = firstText.slice(0, 300).toLowerCase();
      for (const phrase of COMPRESSION_PHRASES) {
        if (head.includes(phrase)) return "compressed";
      }
    }
  }

  return lastIsAnchor ? "anchor" : "continuation";
}

// Signal 1: 主代理 capture 序列里 messageCount 骤降 → 标记为 compressed。
// 需要 cross-capture 状态，所以作为 listCaptures 之后的独立 pass 运行。
// 直接在已缓存的 ListItem 上原地改 kind。用 __originalKind（不可变）做过滤，
// 确保幂等：即使 kind 已在上次 poll 被改为 "compressed"，下次 poll 仍能正确识别原始 anchor。
// Signal 1: a sharp drop in messageCount across the main-agent capture sequence →
// mark as compressed. Needs cross-capture state, so it runs as a separate pass after
// listCaptures. Mutates the cached ListItem.kind in-place. Filters on __originalKind
// (immutable) to ensure idempotency: even if kind was already mutated to "compressed"
// on a prior poll, the original anchors are still correctly identified.
function detectCompressions(items) {
  // 按 session 分组。
  // Group by session.
  const bySession = new Map();
  for (const it of items) {
    const slashIdx = it.name.indexOf("/");
    const session = slashIdx === -1 ? "ungrouped" : it.name.slice(0, slashIdx);
    if (!bySession.has(session)) bySession.set(session, []);
    bySession.get(session).push(it);
  }

  for (const [, sessionItems] of bySession) {
    // 只要 main-agent 的原始 anchor —— 用 __originalKind 而非 kind，
    // 因为 detectCompressions 可能已在上次 poll 把 kind 改成了 "compressed"。
    // __originalKind 在创建时固定，保证此过滤幂等。
    // Only main-agent ORIGINAL anchors — filter on __originalKind instead of kind,
    // since detectCompressions may have already mutated kind to "compressed" on a prior poll.
    // __originalKind is set once at creation, ensuring this filter is idempotent.
    const mainAnchors = sessionItems
      .filter((it) => it.tag === "main" && it.__originalKind === "anchor")
      .sort((a, b) => a.mtime - b.mtime);
    for (let i = 1; i < mainAnchors.length; i++) {
      const prev = mainAnchors[i - 1];
      const curr = mainAnchors[i];
      const drop = prev.messageCount - curr.messageCount;
      const threshold = Math.max(prev.messageCount * 0.2, 10);
      if (drop > threshold) {
        curr.kind = "compressed";
      }
    }
  }
}

// 把每个子代理 / Explore 对话锚点，连到派生它的那条主代理 capture。
// 主代理 capture 的「最后一条 assistant 消息」里的 Agent/Task tool_use 带 prompt 字段；
// 子代理首条 user 消息包含这段 prompt 作为子串。匹配上就写 parentId。
// Link each subagent / explore conversation anchor to the main-agent capture that
// dispatched it. The main-agent capture's LAST assistant turn contains an Agent/Task
// tool_use with a prompt field; the subagent's first user message includes that prompt
// as a substring. On match, write parentId.
function linkSubagents(items) {
  // 按 session 分组。
  // Group by session.
  const bySession = new Map();
  for (const it of items) {
    const slashIdx = it.name.indexOf("/");
    const session = slashIdx === -1 ? "ungrouped" : it.name.slice(0, slashIdx);
    if (!bySession.has(session)) bySession.set(session, []);
    bySession.get(session).push(it);
  }

  for (const [, sessionItems] of bySession) {
    // 1. 从主代理 capture 收集派生指纹（只看最后一条 assistant 消息，自然去重）。
    // 1. Collect dispatch fingerprints from main-agent captures (last assistant msg only — dedupes naturally).
    const fingerprints = [];
    for (const it of sessionItems) {
      if (it.tag !== "main") continue;
      const msgs = it.__messages; // see note below — attached during listCaptures
      if (!Array.isArray(msgs)) continue;
      // 找最后一条 assistant。
      // Find the last assistant message.
      let lastAssistant = null;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === "assistant") { lastAssistant = msgs[i]; break; }
      }
      if (!lastAssistant) continue;
      const content = Array.isArray(lastAssistant.content) ? lastAssistant.content : [];
      for (const b of content) {
        if (!b || typeof b !== "object") continue;
        if (b.type !== "tool_use") continue;
        if (b.name !== "Agent" && b.name !== "Task") continue;
        const prompt = (b.input && typeof b.input === "object" && typeof b.input.prompt === "string") ? b.input.prompt : "";
        if (prompt.length < 20) continue; // too short to be a reliable signal
        fingerprints.push({
          parentCapture: it.name,
          promptHead: prompt.slice(0, 100),
          dispatchedAt: it.mtime,
        });
      }
    }

    // 2. 把每个子代理锚点的首条 user 文本和指纹做子串匹配。
    // 2. Match each subagent anchor's first-user-text against fingerprints via substring.
    for (const it of sessionItems) {
      if (it.tag !== "subagent" && it.tag !== "explore") continue;
      if (it.kind !== "anchor") continue; // only anchors are conversation starts
      const msgs = it.__messages;
      if (!Array.isArray(msgs)) continue;
      const firstUser = msgs.find((m) => m.role === "user");
      if (!firstUser) continue;
      let firstText = "";
      const fc = firstUser.content;
      if (typeof fc === "string") firstText = fc;
      else if (Array.isArray(fc)) {
        // 子代理首条 user 可能含多个 text 块（如 <system-reminder> + 实际 prompt）。
        // 拼接所有 text 块，确保 prompt 子串能命中。
        // The subagent's first user msg may contain multiple text blocks
        // (e.g. <system-reminder> + actual prompt). Concatenate all text blocks
        // so the prompt substring can match.
        const parts = [];
        for (const c of fc) {
          if (c && typeof c === "object" && c.type === "text" && typeof c.text === "string") {
            parts.push(c.text);
          }
        }
        firstText = parts.join("\n");
      }
      if (!firstText) continue;

      // 找匹配的指纹：子串命中。取最早的（= 第一次出现该 prompt 的主代理 capture，
      // 后续 capture 会累积同一 prompt 作为历史，所以最早的是真正的父轮）。
      // 注意：不能按 mtime 排序要求「父在子之前」—— capture 文件在 HTTP 响应完成时写入，
      // 主代理会话比子代理长，其响应完成往往晚于子代理。所以这里不用时间约束。
      // Find matching fingerprint: substring hit. Pick the earliest by mtime
      // (= the first main-agent capture to contain this prompt; later captures
      // accumulate the same prompt as conversation history, so the earliest is
      // the true parent). Note: we cannot require parent-before-child ordering by
      // mtime — capture files are written at HTTP response completion, and main-agent
      // sessions are longer, so their response often completes after the subagent's.
      let best = null;
      let bestMtime = Infinity;
      for (const fp of fingerprints) {
        if (firstText.includes(fp.promptHead) && fp.dispatchedAt < bestMtime) {
          best = fp;
          bestMtime = fp.dispatchedAt;
        }
      }
      if (best) it.parentId = best.parentCapture;
    }
  }
}

export function startServer({ capturesDir, port, publicDir }) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${port}`);

      if (url.pathname === "/api/files") {
        const items = await listCaptures(capturesDir);
        detectCompressions(items);
        linkSubagents(items);
        // __messages 和 __originalKind 是不可枚举的，JSON.stringify 自动跳过，无需手动剥离。
        // __messages and __originalKind are non-enumerable, so JSON.stringify skips them — no manual stripping needed.
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
