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

async function listCaptures(capturesDir) {
  // 递归扫描 capturesDir，包括 session-* 子目录。返回的 name 是相对路径
  // （如 "session-20260708-143022-1234/xxx.json"），前端直接拼到 /api/file?name=。
  const items = [];
  const stack = [""];
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
      try {
        const full = path.join(dir, ent.name);
        const stat = await fs.stat(full);
        const raw = await fs.readFile(full, "utf8");
        const data = JSON.parse(raw);
        const lastUser = extractLastUserText(data);
        items.push({
          name: childRel,
          mtime: stat.mtimeMs,
          size: stat.size,
          status: data.response?.status_code,
          preview: lastUser?.slice(0, 80) ?? "(empty)",
        });
      } catch {
        items.push({ name: childRel, mtime: 0, size: 0, status: 0, preview: "(parse error)" });
      }
    }
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
