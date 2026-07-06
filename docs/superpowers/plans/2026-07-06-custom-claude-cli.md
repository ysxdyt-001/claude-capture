# Custom Claude-like CLI Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `claude-capture` 通过 `--claude <bin>` flag 或 `CLAUDE_CAPTURE_CLAUDE` env 抓包三方套壳 Claude CLI。

**Architecture:** 所有改动集中在 `bin/claude-capture.mjs`。把硬编码的 `"claude"` 替换为一个 `claudeBin` 字段（来自 flag > env > 默认 `"claude"`），并在 preflight / spawn / banner / usage 四处使用它。新增 spawn `error` 事件处理兜底竞态。

**Tech Stack:** Node.js ≥ 20 内置（`child_process.spawn` / `spawnSync`），无新依赖。

## Global Constraints

- 改动**只**在 `bin/claude-capture.mjs`。`lib/addon.py` / `lib/server.mjs` / `public/index.html` 一律不动。
- 注释保持中英双语风格（参考 CLAUDE.md 的 Conventions）。
- 跨平台：Windows 下 `spawn` 已有 `shell: IS_WIN`，不额外校验 bin 名。
- 无 build step、无 test runner —— 验证靠手动运行命令。
- 默认值必须回退到 `"claude"`（向后兼容）。
- 优先级：flag > env > 默认。

---

### Task 1: parseArgs 接收 `--claude` 与 env

**Files:**
- Modify: `bin/claude-capture.mjs:52-107`（`parseArgs` 函数）
- Modify: `bin/claude-capture.mjs:31-50`（`usage` 函数，同步追加 help 文本）

**Interfaces:**
- Produces: `opts.claudeBin: string` —— 后续 preflight / main 使用。

- [ ] **Step 1: 在 `parseArgs` 的 opts 默认值里加 `claudeBin`**

定位 `bin/claude-capture.mjs:52-64` 的 `const opts = { ... }`，在最末尾（`claudeArgs: []` 之后、`};` 之前）追加：

```js
    // CLI bin to capture: flag > env > default "claude".
    // 三方套壳 CLI（基于 Claude Code 二次开发）可通过此参数指定。
    claudeBin: process.env.CLAUDE_CAPTURE_CLAUDE || "claude",
```

- [ ] **Step 2: 在 while 循环里加 `--claude` 分支**

在 `bin/claude-capture.mjs:85-88` 的 `--no-mitmweb-browser` 分支之后、`--port-proxy=` 分支（line 89）之前插入两段。先插空格形式：

```js
    } else if (a === "--claude") {
      opts.claudeBin = argv[++i];
```

再在 `--captures=` 分支之后（line 99 之后、`} else {` 之前，line 100 之前）插等号形式：

```js
    } else if (a.startsWith("--claude=")) {
      opts.claudeBin = a.slice("--claude=".length);
```

- [ ] **Step 3: 在 `usage` 的 Options 区追加一行**

定位 `bin/claude-capture.mjs:39-41` 的 `--no-mitmweb-browser` 那行之后追加：

```
  --claude <bin>        CLI to launch & capture (default: claude, env: CLAUDE_CAPTURE_CLAUDE)
```

- [ ] **Step 4: 在 `usage` 的 Examples 区追加一条示例**

定位 `bin/claude-capture.mjs:46-48` 的示例块，在最后一条 `claude-capture -- --model opus-4-6 --resume` 之后追加：

```
  claude-capture --claude acme-claude
```

- [ ] **Step 5: 手动验证 help 文本**

Run: `node bin/claude-capture.mjs --help`
Expected: 输出包含 `--claude <bin>` 行和 `claude-capture --claude acme-claude` 示例，且 `process.exit(0)` 正常退出。

- [ ] **Step 6: Commit**

```bash
git add bin/claude-capture.mjs
git commit -m "feat: parse --claude flag and CLAUDE_CAPTURE_CLAUDE env"
```

---

### Task 2: preflight 用 `opts.claudeBin` 替换硬编码

**Files:**
- Modify: `bin/claude-capture.mjs:256-262`（claude binary 存在性检查块）

**Interfaces:**
- Consumes: `opts.claudeBin`（来自 Task 1）。

- [ ] **Step 1: 替换 `which("claude")` 为 `which(opts.claudeBin)`，并改写错误信息**

定位 `bin/claude-capture.mjs:256-262`，整块替换为：

```js
  // 3. claude binary (or third-party Claude-like CLI when overridden).
  if (!which(opts.claudeBin)) {
    errors.push(
      `  • ${opts.claudeBin} not found on PATH\n` +
      `    install Claude Code CLI:  https://claude.ai/code\n` +
      `    or override with --claude <bin> / CLAUDE_CAPTURE_CLAUDE=<bin>`
    );
  }
```

- [ ] **Step 2: 手动验证 preflight 错误路径**

Run: `node bin/claude-capture.mjs --claude nonexistent-cli-xyz`
Expected: 在 Preflight failed 区块看到 `nonexistent-cli-xyz not found on PATH`，进程 `exit(1)`。

- [ ] **Step 3: 手动验证默认行为不退化**

Run: `node bin/claude-capture.mjs --help`（仅确认 parse 仍 OK，preflight 未跑）。
然后再确认环境：`which claude` 在本机存在 → 跑 `node bin/claude-capture.mjs`（会进入完整启动流程，可立即 Ctrl+C 中断）。预期 banner 正常打印、不出现 `claude not found`。

- [ ] **Step 4: Commit**

```bash
git add bin/claude-capture.mjs
git commit -m "feat: preflight checks opts.claudeBin instead of hardcoded claude"
```

---

### Task 3: main 用 `opts.claudeBin` spawn + 加 spawn error 兜底

**Files:**
- Modify: `bin/claude-capture.mjs:328`（banner 的 `claude : starting...` 行）
- Modify: `bin/claude-capture.mjs:383-387`（spawn 调用）
- Modify: `bin/claude-capture.mjs:405-408`（`claude.on("exit")` 之前插入 error handler）

**Interfaces:**
- Consumes: `opts.claudeBin`（来自 Task 1）。

- [ ] **Step 1: banner 行用实际 bin 名**

定位 `bin/claude-capture.mjs:328`，把：

```js
  process.stdout.write(`  claude   : starting${opts.claudeArgs.length ? ` with ${JSON.stringify(opts.claudeArgs)}` : ""}\n`);
```

改为：

```js
  process.stdout.write(`  ${opts.claudeBin}   : starting${opts.claudeArgs.length ? ` with ${JSON.stringify(opts.claudeArgs)}` : ""}\n`);
```

- [ ] **Step 2: spawn 用 `opts.claudeBin`**

定位 `bin/claude-capture.mjs:383-387`：

```js
  const claude = spawn("claude", opts.claudeArgs, {
    env: claudeEnv,
    stdio: "inherit",
    shell: IS_WIN,
  });
```

改为：

```js
  const claude = spawn(opts.claudeBin, opts.claudeArgs, {
    env: claudeEnv,
    stdio: "inherit",
    shell: IS_WIN,
  });
```

- [ ] **Step 3: 新增 spawn error 兜底**

定位 `bin/claude-capture.mjs:405` 的 `claude.on("exit", ...)`。在它**之前**插入：

```js
  // Spawn-time 错误兜底：preflight 通过 → spawn 之间出现竞态（bin 被删 / PATH 改动）
  // 时，没有 'error' 事件 Node 会抛裸 stack。这里转成可读的 fatal 后再清理。
  claude.on("error", (err) => {
    process.stderr.write(`\n  fatal: ${opts.claudeBin} failed to start: ${err.message}\n\n`);
    try { mitm.kill("SIGTERM"); } catch {}
    setTimeout(() => process.exit(1), 100);
  });

```

- [ ] **Step 4: 手动验证 banner 显示自定义 bin 名**

Run: `node bin/claude-capture.mjs --claude nonexistent-cli-xyz`
Expected: preflight 阶段已 exit 1（Task 2 验证过），不会到 banner。

Run（在 mitmweb/claude 都装好的机器上）: `node bin/claude-capture.mjs --claude claude`，banner 中 `claude   : starting` 这一行（用默认值时显示 `claude`，用 `--claude acme-claude` 时显示 `acme-claude`），看到后立即 Ctrl+C。

- [ ] **Step 5: 手动验证 spawn error 兜底（可选 / 模拟）**

如果手头没有可移除的 bin，可以临时造一个：在 preflight 通过后手动 `mv` 掉某 PATH 上的 bin 较难复现；更简单的做法是临时改代码把 `opts.claudeBin` 喂个 `definitely-not-real` 并跳过 preflight。**这条 step 是 best-effort，无法稳定复现时跳过即可**，因为 error handler 是纯防御代码，逻辑直白。

- [ ] **Step 6: Commit**

```bash
git add bin/claude-capture.mjs
git commit -m "feat: spawn opts.claudeBin + handle spawn-time error"
```

---

### Task 4: README 同步（如果存在）

**Files:**
- Modify: `README.md`（如果项目根有这个文件且包含 Options/Usage 段落）

**Interfaces:** 无。

- [ ] **Step 1: 检查 README 是否需要更新**

Run: `ls /Users/sunzengguang/WebstormProjects/claude-capture/README.md 2>/dev/null && echo EXISTS || echo MISSING`

如果输出 `MISSING`：跳过本 Task（无 README 可改），直接进入 Step 4。
如果输出 `EXISTS`：用 Read 工具打开它，定位是否有 Options 表 / Usage 段落列出了 `--port-*` 等 flag。

- [ ] **Step 2:（仅当 README 存在且列了 flag）追加 `--claude` 一行**

在 `--no-mitmweb-browser`（或对应描述）那一行之后追加：

```markdown
- `--claude <bin>` — 三方套壳 Claude CLI 的可执行文件名 / 三方 Claude-like CLI binary to launch & capture (default: `claude`, env: `CLAUDE_CAPTURE_CLAUDE`)
```

并在 Usage 示例区（如果有）追加：

```
claude-capture --claude acme-claude
```

- [ ] **Step 3: Commit（仅当 README 改了）**

```bash
git add README.md
git commit -m "docs: document --claude flag in README"
```

- [ ] **Step 4: 标记 Task 4 完成**

无论是否改了 README，标记 Task 4 完成。

---

## 验收清单（实施完所有 task 后跑一遍）

1. `node bin/claude-capture.mjs --help` —— 输出含 `--claude <bin>` 行 + `claude-capture --claude acme-claude` 示例
2. `node bin/claude-capture.mjs --claude nonexistent-cli-xyz` —— Preflight failed，错误信息含 `nonexistent-cli-xyz not found on PATH`，exit 1
3. `CLAUDE_CAPTURE_CLAUDE=nonexistent-cli-xyz node bin/claude-capture.mjs` —— 同上（验证 env 生效）
4. `node bin/claude-capture.mjs --claude claude` —— banner 行显示 `claude   : starting`，Ctrl+C 正常退出
5. `node bin/claude-capture.mjs`（不传任何 flag，机器上 claude/mitmweb 齐全时）—— 行为与改动前完全一致（向后兼容）

## Self-Review 结果

- ✅ Spec 全部需求（flag / env / 默认 / preflight / spawn / banner / usage / spawn error 兜底 / 边界）都有对应 task
- ✅ 无 placeholder，所有 step 都给了具体代码 / 命令 / 预期输出
- ✅ 类型 / 字段名一致：`opts.claudeBin` 在三个 task 中拼写相同
- ✅ Task 1（parse）→ Task 2（preflight）→ Task 3（spawn）依赖顺序正确，每个 task 单独 commit 可独立 review
- ⚠️ 项目无 test runner，TDD 步骤改为"手动验证"（每 task 都给了具体命令 + 预期输出）
