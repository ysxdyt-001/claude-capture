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
// 静态资源目录：Vite 构建产物（web/ 源码经 npm run build 生成）。
// Static assets dir: Vite build output (built from web/ source via npm run build).
const PUBLIC_DIR = path.join(PKG_ROOT, "dist");
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
  --port-proxy <n>      mitmweb proxy listen port      (default 8080, auto-picks next free if busy)
  --port-mitmweb <n>    mitmweb Web UI port            (default 8081, auto-picks next free if busy)
  --port-viewer <n>     viewer HTTP port               (default 8090, auto-picks next free if busy)
  --captures <path>     captures output directory     (default ~/.claude-capture/captures)
  --max-captures <n>    keep at most N capture files, pruning oldest  (default 500)
  --no-browser          do not auto-open the viewer in browser
  --no-mitmweb-browser  do not auto-open the mitmweb Web UI in browser
  --claude <bin>        CLI to launch & capture (default: claude, env: CLAUDE_CAPTURE_CLAUDE)
  -h, --help            show this help

Anything after "--" is forwarded verbatim to claude.
Examples:
  claude-capture
  claude-capture --port-proxy 9090
  claude-capture -- --model opus-4-6 --resume
  claude-capture --claude acme-claude
`.trim();
}

function parseArgs(argv) {
  const opts = {
    portProxy: 8080,
    portViewer: 8090,
    portMitmweb: 8081,
    portProxyExplicit: false,
    portViewerExplicit: false,
    portMitmwebExplicit: false,
    captures: path.join(os.homedir(), ".claude-capture", "captures"),
    maxCaptures: 500,
    openBrowser: true,
    openMitmwebBrowser: true,
    claudeArgs: [],
    // CLI bin to capture: flag > env > default "claude".
    // 三方套壳 CLI（基于 Claude Code 二次开发）可通过此参数指定。
    claudeBin: process.env.CLAUDE_CAPTURE_CLAUDE || "claude",
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
      opts.portProxyExplicit = true;
    } else if (a === "--port-viewer") {
      opts.portViewer = Number(argv[++i]);
      opts.portViewerExplicit = true;
    } else if (a === "--port-mitmweb") {
      opts.portMitmweb = Number(argv[++i]);
      opts.portMitmwebExplicit = true;
    } else if (a === "--captures") {
      opts.captures = path.resolve(argv[++i]);
    } else if (a === "--max-captures") {
      opts.maxCaptures = Number(argv[++i]);
    } else if (a === "--no-browser") {
      opts.openBrowser = false;
    } else if (a === "--no-mitmweb-browser") {
      opts.openMitmwebBrowser = false;
    } else if (a === "--claude") {
      opts.claudeBin = argv[++i];
    } else if (a.startsWith("--port-proxy=")) {
      opts.portProxy = Number(a.slice("--port-proxy=".length));
      opts.portProxyExplicit = true;
    } else if (a.startsWith("--port-viewer=")) {
      opts.portViewer = Number(a.slice("--port-viewer=".length));
      opts.portViewerExplicit = true;
    } else if (a.startsWith("--port-mitmweb=")) {
      opts.portMitmweb = Number(a.slice("--port-mitmweb=".length));
      opts.portMitmwebExplicit = true;
    } else if (a.startsWith("--captures=")) {
      opts.captures = path.resolve(a.slice("--captures=".length));
    } else if (a.startsWith("--max-captures=")) {
      opts.maxCaptures = Number(a.slice("--max-captures=".length));
    } else if (a.startsWith("--claude=")) {
      opts.claudeBin = a.slice("--claude=".length);
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

// Test whether we can bind on the port. We try BOTH 0.0.0.0 and 127.0.0.1
// because macOS's SO_REUSEADDR behavior is asymmetric:
//   • binding 127.0.0.1 misses conflicts on 0.0.0.0
//   • binding 0.0.0.0   misses conflicts on 127.0.0.1
// Only if BOTH succeed do we consider the port free.
function tryBind(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}
async function isPortFree(port) {
  return (await tryBind(port, "0.0.0.0")) && (await tryBind(port, "127.0.0.1"));
}

// Find the first free port starting from `startPort`. Returns null after maxTries.
function findFreePort(startPort, maxTries = 50) {
  return (async () => {
    for (let offset = 0; offset < maxTries; offset++) {
      const port = startPort + offset;
      if (await isPortFree(port)) return port;
    }
    return null;
  })();
}

// Pick a port: if user didn't explicitly request one, auto-pick the first free
// port starting from the default. If user did request one, validate it's free.
// `chosen` tracks ports already picked by previous resolvePort calls so we
// don't accidentally double-assign.
async function resolvePort(label, portKey, explicitKey, opts, notes, chosen) {
  const wanted = opts[portKey];
  if (opts[explicitKey]) {
    // User explicitly chose this port — must be free or hard error.
    if (!(await isPortFree(wanted))) {
      return { error: `port ${wanted} (${label}) is already in use — free it or pick a different --port-${label}` };
    }
    chosen.add(wanted);
    return {};
  }
  // Default behavior — find first free starting from the default, skipping any
  // port already claimed by a previous resolver.
  for (let offset = 0; offset < 50; offset++) {
    const candidate = wanted + offset;
    if (chosen.has(candidate)) continue;
    if (await isPortFree(candidate)) {
      opts[portKey] = candidate;
      chosen.add(candidate);
      if (candidate !== wanted) {
        notes.push(`port ${wanted} (${label}) busy → using ${candidate}`);
      }
      return {};
    }
  }
  return { error: `no free port found in range ${wanted}-${wanted + 49} (${label})` };
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

  // 2. mitmweb binary + version. We keep mitmweb (not mitmdump) because its
  //    Web UI is valuable — users can inspect every raw request, not just the
  //    Anthropic ones our addon captures.
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

  // 3. claude binary (or third-party Claude-like CLI when overridden).
  if (!which(opts.claudeBin)) {
    errors.push(
      `  • ${opts.claudeBin} not found on PATH\n` +
      `    install Claude Code CLI:  https://claude.ai/code\n` +
      `    or override with --claude <bin> / CLAUDE_CAPTURE_CLAUDE=<bin>`
    );
  }

  // 4. mitmproxy CA cert
  if (!fsSync.existsSync(MITM_CA)) {
    errors.push(
      `  • mitmproxy CA cert missing: ${MITM_CA}\n` +
      `    run "mitmweb" once to generate it (then Ctrl+C)`
    );
  }

  // 5. Ports: auto-pick next free port if default is taken (only when user
  //    did NOT pass --port-* explicitly).
  const portNotes = [];
  const chosen = new Set();
  const proxyRes = await resolvePort("proxy", "portProxy", "portProxyExplicit", opts, portNotes, chosen);
  if (proxyRes.error) errors.push(`  • ${proxyRes.error}`);
  const mitmwebRes = await resolvePort("mitmweb-ui", "portMitmweb", "portMitmwebExplicit", opts, portNotes, chosen);
  if (mitmwebRes.error) errors.push(`  • ${mitmwebRes.error}`);
  const viewerRes = await resolvePort("viewer", "portViewer", "portViewerExplicit", opts, portNotes, chosen);
  if (viewerRes.error) errors.push(`  • ${viewerRes.error}`);

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
  // Stash port notes so main() can print them after the banner.
  opts._portNotes = portNotes;
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

// Cross-platform process-tree kill.
// 关键点：Windows 上 spawn(shell: true) 出来的 child 是 cmd.exe，真正的 mitmweb /
// claude 进程是 cmd.exe 的子进程。child.kill() 只杀 cmd.exe，真正进程变孤儿
// （这是用户报告的"关闭后服务残留"的根因）。taskkill /T /F 递归杀整棵进程树。
//
// Unix 上 child.kill(signal) 行为正确，沿用即可。
function killTree(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (pid == null) return;
  try {
    if (IS_WIN) {
      // /T 递归子进程，/F 强制（SIGKILL 等价）。mitmweb 自己不捕 CTRL_BREAK，
      // 直接 TerminateProcess 是最稳的。
      spawn("taskkill", ["/T", "/F", "/PID", String(pid)], {
        stdio: "ignore",
        shell: false,
      });
    } else {
      child.kill(signal);
    }
  } catch {}
}

// 同步版本，仅供 process.on("exit") 兜底使用（exit handler 只能跑同步代码）。
function killTreeSync(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (pid == null) return;
  try {
    if (IS_WIN) {
      spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
        stdio: "ignore",
        shell: false,
      });
    } else {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  } catch {}
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  await preflight(opts);

  await fs.mkdir(opts.captures, { recursive: true });

  // 校验抓取数量上限：非正整数会让 addon 的取模清理逻辑失效。
  if (!Number.isInteger(opts.maxCaptures) || opts.maxCaptures < 1) {
    process.stderr.write(`\n  fatal: --max-captures must be a positive integer (got ${opts.maxCaptures})\n\n`);
    process.exit(1);
  }

  // mitmweb 的 stderr 落盘到日志文件 —— addon 的 [addon] ERROR 之前被 stdio: ignore
  // 完全吞掉，导致 Windows 非 UTF-8 区域下 0 字节 captures 这种静默失败无法排查
  // （见 issue #1）。stdout 仍 ignore，避免和 claude 的 TUI 撕裂。
  const mitmLogPath = path.join(path.dirname(opts.captures), "mitmweb.log");
  const mitmLogFd = fsSync.openSync(mitmLogPath, "a");
  // 写一行分隔标记，方便多次运行后从日志里区分本次会话。
  fsSync.writeSync(mitmLogFd, `\n==== claude-capture ${new Date().toISOString()} ====\n`);

  process.stdout.write(BANNER + "\n");
  process.stdout.write(`  captures : ${opts.captures}  (max ${opts.maxCaptures})\n`);
  process.stdout.write(`  mitm.log : ${mitmLogPath}\n`);
  process.stdout.write(`  proxy    : http://127.0.0.1:${opts.portProxy}  (mitmweb + addon)\n`);
  process.stdout.write(`  mitmweb  : http://127.0.0.1:${opts.portMitmweb}  (raw flow inspector)\n`);
  process.stdout.write(`  viewer   : http://127.0.0.1:${opts.portViewer}  (anthropic captures)\n`);
  process.stdout.write(`  ${opts.claudeBin}   : starting${opts.claudeArgs.length ? ` with ${JSON.stringify(opts.claudeArgs)}` : ""}\n`);
  if (opts._portNotes?.length) {
    process.stdout.write(`  notes    : ${opts._portNotes.join("; ")}\n`);
  }
  process.stdout.write("\n");

  // 1) 起 viewer（in-process）
  await startServer({
    capturesDir: opts.captures,
    port: opts.portViewer,
    publicDir: PUBLIC_DIR,
  });

  // 2) spawn mitmweb — proxy port + addon + Web UI (valuable: shows every raw
  //    request, not just the Anthropic ones our addon captures).
  const mitm = spawn(
    "mitmweb",
    [
      "-p", String(opts.portProxy),
      "--web-port", String(opts.portMitmweb),
      "-s", ADDON_PATH,
      "--set", `web_open_browser=${opts.openMitmwebBrowser ? "true" : "false"}`,
      "--set", "console_eventlog_verbosity=warn",
    ],
    {
      env: {
        ...process.env,
        CLAUDE_CAPTURE_DIR: opts.captures,
        CLAUDE_CAPTURE_MAX: String(opts.maxCaptures),
        // 纵深防御：强制 mitmweb 子进程（含 addon.py）进入 UTF-8 模式，
        // 即使将来出现新的写盘点也能在 Windows 非 UTF-8 区域下安全工作。
        PYTHONUTF8: "1",
      },
      // mitmweb 的 stdout 仍 ignore（避免和 claude TUI 撕裂），但 stderr 落到
      // mitmLogFd 指向的日志文件 —— addon 的 [addon] ERROR 会出现在那里，
      // 静默失败时可以 tail ~/.claude-capture/mitmweb.log 排查。
      // 启动失败仍会被下面的 probePort 兜住（5s 内没起来就 abort）。
      stdio: ["ignore", "ignore", mitmLogFd],
      shell: IS_WIN,
    }
  );

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
  const claude = spawn(opts.claudeBin, opts.claudeArgs, {
    env: claudeEnv,
    stdio: "inherit",
    shell: IS_WIN,
  });

  // 6) 生命周期：claude 退出 / 信号 → 树杀清理。
  // 之前用 child.kill()，Windows 下 child 是 cmd.exe（shell:true 包装），真正的
  // mitmweb / claude 是 cmd.exe 的子进程，kill 只杀 cmd.exe → 真进程变孤儿
  // （用户报告的"关闭后服务残留"）。现在统一走 killTree，Windows 用 taskkill /T /F。
  let shuttingDown = false;
  const cleanup = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    killTree(claude, signal);
    setTimeout(() => {
      killTree(mitm, IS_WIN ? "SIGTERM" : signal);
      setTimeout(() => process.exit(0), 200);
    }, 100);
  };
  // SIGINT (Ctrl+C)、SIGTERM (kill)、SIGHUP (终端关闭)、SIGQUIT (Ctrl+\)、
  // SIGBREAK (Windows Ctrl+Break / 关控制台) 全部走 cleanup。
  process.on("SIGINT", () => cleanup("SIGINT"));
  process.on("SIGTERM", () => cleanup("SIGTERM"));
  process.on("SIGHUP", () => cleanup("SIGHUP"));
  process.on("SIGQUIT", () => cleanup("SIGQUIT"));
  process.on("SIGBREAK", () => cleanup("SIGBREAK"));

  // 最后兜底：如果上面的 setTimeout 还没跑到进程就被强制收掉（例如 SIGKILL 之外
  // 的路径触发了 process.exit），exit handler 里同步树杀一次。仅 best-effort。
  process.on("exit", () => {
    killTreeSync(claude);
    killTreeSync(mitm);
  });

  // Spawn-time 错误兜底：preflight 通过 → spawn 之间出现竞态（bin 被删 / PATH 改动）
  // 时，没有 'error' 事件 Node 会抛裸 stack。这里转成可读的 fatal 后再清理。
  claude.on("error", (err) => {
    process.stderr.write(`\n  fatal: ${opts.claudeBin} failed to start: ${err.message}\n\n`);
    killTree(mitm, "SIGTERM");
    setTimeout(() => process.exit(1), 100);
  });

  claude.on("exit", (code) => {
    killTree(mitm, "SIGTERM");
    setTimeout(() => process.exit(code ?? 0), 200);
  });
}

main().catch((err) => {
  process.stderr.write(`\n  fatal: ${err?.stack || err}\n\n`);
  process.exit(1);
});
