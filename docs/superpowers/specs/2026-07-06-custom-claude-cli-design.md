# Custom Claude-like CLI Support

**Date:** 2026-07-06
**Status:** Approved (design)

## Goal

让 `claude-capture` 能抓包三方"套壳" Claude CLI —— 即基于 Claude Code 二次开发、启动命令名不同（如 `acme-claude`、`mycorp-ai`）但行为兼容的 CLI。用户通过 flag 或 env 指定要启动的可执行文件名，工具其余部分（mitmweb 代理、addon、viewer）保持不变。

## Non-goals (YAGNI)

- 不改 `addon.py` 的路径过滤（仍只抓 `/messages`，三方 CLI 默认走相同端点）
- 不做配置文件（`~/.claude-capture/config.json` 之类）—— flag + env 已经够用
- 不做版本检查 / 兼容性探测 —— 三方 CLI 的 `--version` 输出格式不可预测
- 不改 `--` 之后的 args 透传行为

## User-facing API

### Flag
```
claude-capture --claude <bin>
claude-capture --claude=<bin>
```

### Env
```
CLAUDE_CAPTURE_CLAUDE=<bin> claude-capture
```

### 优先级
flag > env > 默认值 `"claude"`（向后兼容）。

### 默认值
未指定时回退到 `"claude"` —— 老用户体验完全不变。

### Help 文本新增
```
--claude <bin>         CLI to launch & capture (default: claude, env: CLAUDE_CAPTURE_CLAUDE)
```
示例区追加：
```
claude-capture --claude acme-claude
```

## Implementation (改动点全在 `bin/claude-capture.mjs`)

### 1. `parseArgs`
- 新增 `claudeBin` 字段，默认值 `process.env.CLAUDE_CAPTURE_CLAUDE || "claude"`
- 处理 `--claude <bin>` 和 `--claude=<bin>` 两种形式
- 写入 `opts.claudeBin`（flag 命中时覆盖默认）

### 2. `preflight`
- 现有 `which("claude")` 替换为 `which(opts.claudeBin)`
- 失败时的错误信息用实际 bin 名：
  ```
  • <bin> not found on PATH
    install Claude Code CLI:  https://claude.ai/code
    or override with --claude <bin> / CLAUDE_CAPTURE_CLAUDE=<bin>
  ```
- 不跑 `--version`（三方 CLI 输出格式不可预测，强行 parse 会误报）

### 3. `main`
- `spawn("claude", ...)` → `spawn(opts.claudeBin, ...)`
- banner 行 `claude   : starting...` → `${opts.claudeBin}   : starting...`
- 新增 `claude.on("error", (err) => ...)`：
  - 处理 spawn 阶段的 ENOENT（preflight 与 spawn 之间的竞态：例如 bin 在 preflight 后被删）
  - 输出 `fatal: <bin> failed to start: <message>` 并非零退出
  - 不让裸 stack 泄漏到终端

### 4. `usage`
- 在 Options 区追加 `--claude <bin>` 一行
- 在 Examples 区追加一条示例

## 不改动
- `lib/addon.py`（路径过滤仍是 `/messages`）
- `lib/server.mjs`、`public/index.html`（viewer 不关心被抓的是谁）
- `--` 之后的透传逻辑
- `which("mitmweb")`、CA cert、端口解析等其它 preflight

## Edge cases

| 场景 | 行为 |
|------|------|
| 既没 flag 也没 env | bin = `"claude"`，行为同现状 |
| flag 和 env 都有 | flag 赢 |
| bin 不在 PATH | preflight 失败，exit 1，错误信息引用实际 bin 名 |
| preflight 通过但 spawn 时 ENOENT（竞态） | `claude.on("error")` 兜底，输出 fatal 后非零退出 |
| bin 名含空格 / 路径分隔符 | 交给 spawn 处理（已有 `shell: IS_WIN`），不额外校验 |

## Testing

无自动化测试套件（项目本身无 test infra）。手动验证清单：

1. `claude-capture --help` —— 新增行 + 示例出现
2. `claude-capture` —— 行为同现状（bin 回退到 `claude`）
3. `CLAUDE_CAPTURE_CLAUDE=claude claude-capture` —— 同上
4. `claude-capture --claude nonexistent-cli` —— preflight 失败，错误信息含 `nonexistent-cli`
5. `claude-capture --claude <某个真实三方 CLI>` —— 正常抓包（如有真实环境）
6. banner 行显示用户指定的 bin 名

## Rollout

单 PR / 单 commit，无破坏性变更（默认值不变）。
