#!/usr/bin/env node
// claude-capture：编排 mitmweb + viewer + claude 三个服务。
// 用户在任意目录敲这个命令，就能开始抓包。
// 跨平台支持 macOS / Linux / Windows。

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { startServer } from "../lib/server.mjs";

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..");
const ADDON_PATH = path.join(PKG_ROOT, "lib", "addon.py");
const PUBLIC_DIR = path.join(PKG_ROOT, "public");
const MITM_CA = path.join(os.homedir(), ".mitmproxy", "mitmproxy-ca-cert.pem");

const MIN_NODE_MAJOR = 20;
const MIN_MITMPROXY_MAJOR = 10;

const BANNER = `
  claude-capture · inspect Claude Code ↔ Anthropic HTTP traffic
`;

function usage() {
  return `
Usage: claude-capture [options] [-- <claude-args>...]

Options:
  --port-proxy <n>      mitmproxy listen port        (default 8080)
  --port-viewer <n>     viewer HTTP port              (default 8090)
  --captures <path>     captures output directory     (default ~/.claude-capture/captures)
  --no-browser          do not auto-open the viewer in browser
  -h, --help            show this help

Anything after "--" is forwarded verbatim to claude.
Examples:
  claude-capture
  claude-capture --port-proxy 9090
  claude-capture -- --model opus-4-6 --resume
`.trim();
}

function parseArgs(argv) {
  const opts = {
    portProxy: 8080,
    portViewer: 8090,
    captures: path.join(os.homedir(), ".claude-capture", "captures"),
    openBrowser: true,
    claudeArgs: [],
  };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--") {
      opts.claudeArgs = argv.slice(i + 1);
      break;
    } else if (a === "-h" || a === "--help") {
      process.stdout.write(usage() + "\n");
      process.exit(0);
    } else if (a === "--port-proxy") {
      opts.portProxy = Number(argv[++i]);
    } else if (a === "--port-viewer") {
      opts.portViewer = Number(argv[++i]);
    } else if (a === "--captures") {
      opts.captures = path.resolve(argv[++i]);
    } else if (a === "--no-browser") {
      opts.openBrowser = false;
    } else if (a.startsWith("--port-proxy=")) {
      opts.portProxy = Number(a.slice("--port-proxy=".length));
    } else if (a.startsWith("--port-viewer=")) {
      opts.portViewer = Number(a.slice("--port-viewer=".length));
    } else if (a.startsWith("--captures=")) {
      opts.captures = path.resolve(a.slice("--captures=".length));
    } else {
      process.stderr.write(`unknown option: ${a}\n${usage()}\n`);
      process.exit(2);
    }
    i++;
  }
  return opts;
}

// Cross-platform binary lookup.
function which(bin) {
  const cmd = IS_WIN ? "where" : "which";
  // Windows: where.exe is a real binary, no shell needed.
  // Some npm-installed CLIs land as .cmd — `where` finds those by extension search.
  const r = spawnSync(cmd, [bin], { stdio: "ignore" });
  return r.status === 0;
}

// Run `<bin> --version` and return the first trimmed line (or null).
function getCommandVersion(bin) {
  const r = spawnSync(bin, ["--version"], {
    encoding: "utf8",
    shell: IS_WIN, // Windows: needed to resolve .cmd/.bat wrappers
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (r.status !== 0 || !r.stdout) return null;
  return r.stdout.trim().split("\n")[0];
}

function parseNodeMajor(raw) {
  // Strip leading v (e.g. "v20.11.0") and take the first integer.
  const m = /^v?(\d+)/.exec(raw);
  return m ? parseInt(m[1], 10) : null;
}

// Parse `Mitmproxy: 12.1.1` style output → 12.
function parseMitmproxyMajor(output) {
  const m = /Mitmproxy[:\s]+(\d+)/i.exec(output || "");
  return m ? parseInt(m[1], 10) : null;
}

// Test whether we can bind on the port (i.e. nothing else is listening).
function isPortFree(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

// Wait until something answers on the port (used to detect when mitmweb is up).
function probePort(port, host, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      const ok = await new Promise((resolve) => {
        const sock = net.connect({ port, host }, () => {
          sock.end();
          resolve(true);
        });
        sock.on("error", () => resolve(false));
      });
      if (ok) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  })();
}

async function preflight(opts) {
  const errors = [];
  const warnings = [];

  // 1. Node version
  const nodeRaw = process.versions.node;
  const nodeMajor = parseNodeMajor(nodeRaw);
  if (!nodeMajor || nodeMajor < MIN_NODE_MAJOR) {
    errors.push(
      `  • Node.js ${nodeRaw} is too old (need >= ${MIN_NODE_MAJOR})\n` +
      `    upgrade:  nvm install ${MIN_NODE_MAJOR}  |  brew install node@${MIN_NODE_MAJOR}  |  winget install OpenJS.NodeJS`
    );
  }

  // 2. mitmweb binary + version
  if (!which("mitmweb")) {
    errors.push(
      `  • mitmweb not found on PATH\n` +
      `    install mitmproxy:  brew install mitmproxy  (macOS)\n` +
      `                       sudo apt install mitmproxy  (Linux)\n` +
      `                       https://mitmproxy.org/downloads/  (Windows installer)`
    );
  } else {
    const mitmVer = getCommandVersion("mitmweb");
    if (mitmVer) {
      const major = parseMitmproxyMajor(mitmVer);
      if (major && major < MIN_MITMPROXY_MAJOR) {
        errors.push(
          `  • mitmproxy too old: "${mitmVer}" (need >= ${MIN_MITMPROXY_MAJOR}.x)\n` +
          `    upgrade:  brew upgrade mitmproxy  |  pip install --upgrade mitmproxy`
        );
      }
    }
  }

  // 3. claude binary
  if (!which("claude")) {
    errors.push(
      `  • claude not found on PATH\n` +
      `    install Claude Code CLI:  https://claude.ai/code`
    );
  }

  // 4. mitmproxy CA cert
  if (!fsSync.existsSync(MITM_CA)) {
    errors.push(
      `  • mitmproxy CA cert missing: ${MITM_CA}\n` +
      `    run "mitmweb" once to generate it (then Ctrl+C)`
    );
  }

  // 5. Ports must be free (we'll bind viewer in-process; mitmweb spawns its own listener).
  for (const [label, port] of [["proxy", opts.portProxy], ["viewer", opts.portViewer]]) {
    const free = await isPortFree(port);
    if (!free) {
      errors.push(
        `  • port ${port} (${label}) is already in use\n` +
        `    free it, or override:  --port-${label} <other-port>`
      );
    }
  }

  // 6. Anthropic auth env vars (soft warning — claude may use a config file instead).
  const hasToken = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  if (!hasToken) {
    warnings.push(
      `  • no ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN in env — claude may fail to authenticate`
    );
  }

  if (warnings.length) {
    process.stderr.write("\n  Warnings:\n\n" + warnings.join("\n") + "\n");
  }
  if (errors.length) {
    process.stderr.write("\n  Preflight failed:\n\n" + errors.join("\n") + "\n\n");
    process.exit(1);
  }
}

// Open a URL in the platform default browser. Best-effort, never throws.
function openBrowser(url) {
  try {
    if (IS_MAC) {
      spawn("open", [url], { stdio: "ignore" });
    } else if (IS_WIN) {
      // `start "" <url>` — empty title is required when args contain spaces/colons.
      spawn("cmd", ["/c", "start", "", url], { stdio: "ignore" });
    } else {
      spawn("xdg-open", [url], { stdio: "ignore" });
    }
  } catch {}
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  await preflight(opts);

  await fs.mkdir(opts.captures, { recursive: true });

  process.stdout.write(BANNER + "\n");
  process.stdout.write(`  captures : ${opts.captures}\n`);
  process.stdout.write(`  proxy    : http://127.0.0.1:${opts.portProxy}  (mitmweb + addon)\n`);
  process.stdout.write(`  viewer   : http://127.0.0.1:${opts.portViewer}\n`);
  process.stdout.write(`  claude   : starting${opts.claudeArgs.length ? ` with ${JSON.stringify(opts.claudeArgs)}` : ""}\n\n`);

  // 1) 起 viewer（in-process）
  await startServer({
    capturesDir: opts.captures,
    port: opts.portViewer,
    publicDir: PUBLIC_DIR,
  });

  // 2) spawn mitmweb (Windows: shell=true so mitmweb.exe / mitmweb.cmd resolve via PATH)
  const mitm = spawn(
    "mitmweb",
    [
      "-p", String(opts.portProxy),
      "-s", ADDON_PATH,
      "--set", "web_open_browser=false",
      "--set", "console_eventlog_verbosity=warn",
    ],
    {
      env: { ...process.env, CLAUDE_CAPTURE_DIR: opts.captures },
      stdio: ["ignore", "pipe", "pipe"],
      shell: IS_WIN,
    }
  );
  mitm.stdout.on("data", (d) => process.stdout.write(`[mitm] ${d}`));
  mitm.stderr.on("data", (d) => process.stderr.write(`[mitm] ${d}`));

  // 3) 等 mitmweb 起来
  const proxyReady = await probePort(opts.portProxy, "127.0.0.1", 5000);
  if (!proxyReady) {
    process.stderr.write("\n  mitmweb failed to start within 5s — aborting.\n\n");
    try { mitm.kill("SIGTERM"); } catch {}
    process.exit(1);
  }

  // 4) 自动开浏览器
  if (opts.openBrowser) {
    openBrowser(`http://127.0.0.1:${opts.portViewer}`);
  }

  // 5) spawn claude —— stdio 直接接通用户终端
  const claudeEnv = {
    ...process.env,
    HTTPS_PROXY: `http://127.0.0.1:${opts.portProxy}`,
    HTTP_PROXY: `http://127.0.0.1:${opts.portProxy}`,
    NODE_USE_ENV_PROXY: "1",
    NODE_EXTRA_CA_CERTS: MITM_CA,
  };
  const claude = spawn("claude", opts.claudeArgs, {
    env: claudeEnv,
    stdio: "inherit",
    shell: IS_WIN,
  });

  // 6) 生命周期：claude 退出 → 清理 mitm
  let shuttingDown = false;
  const cleanup = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { claude.kill(signal); } catch {}
    setTimeout(() => {
      try { mitm.kill(IS_WIN ? "SIGTERM" : signal); } catch {}
      // Windows: taskkill /T /F would be more thorough for grandchildren, but
      // mitmweb here has no children of its own (the addon runs in-process).
      setTimeout(() => process.exit(0), 200);
    }, 100);
  };
  process.on("SIGINT", () => cleanup("SIGINT"));
  process.on("SIGTERM", () => cleanup("SIGTERM"));

  claude.on("exit", (code) => {
    try { mitm.kill("SIGTERM"); } catch {}
    setTimeout(() => process.exit(code ?? 0), 200);
  });
}

main().catch((err) => {
  process.stderr.write(`\n  fatal: ${err?.stack || err}\n\n`);
  process.exit(1);
});
