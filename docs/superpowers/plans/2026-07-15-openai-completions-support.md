# OpenAI-spec capture support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the claude-capture viewer render OpenAI-spec (`/chat/completions`, `/completions`) captures with the same fidelity as native Anthropic `/messages` captures.

**Architecture:** Boundary normalization — a new module `web/src/lib/openai.ts` sniffs each capture loaded via `/api/file`. If it matches the OpenAI shape, the capture is translated in memory into the existing Anthropic-shape internal model (`Message`, `ContentBlock`, `ToolUseBlock`, etc.). All downstream components (ConversationTab, buildConversationItems, Message, ToolPair) stay unchanged. A `_format: "openai" | "anthropic"` marker lets SseTimeline and ResponseTab branch on labeling/rebuild without touching data flow.

**Tech Stack:** TypeScript, React, Vite. No new runtime dependencies. No backend changes (the addon already captures OpenAI paths; `/api/file` only serves raw bytes).

## Global Constraints

- **No test suite exists** (per `CLAUDE.md`). All verification is manual: `cd web && npm run build`, then load a sample capture in the browser and check tabs render.
- **Bilingual comments** (Chinese + English) matching surrounding style — header comment per file, inline Chinese where logic is non-obvious.
- **No new runtime dependencies.** Root `package.json` has zero runtime deps and the file list is locked. Viewer-only dev tooling lives in `web/package.json`.
- **Don't touch `lib/addon.py`, `lib/server.mjs`, `bin/claude-capture.mjs`.** The addon already captures `/chat/completions` and `/completions`; the orchestrator already supports `--claude <bin>`. All work is under `web/src/`.
- **Types stay minimal.** OpenAI data is reshaped to fit existing types — no parallel `OpenAIMessage`/`OpenAIChoice` type tree. The only type change is adding `_format?: "openai" | "anthropic"` to `Capture`.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `web/src/lib/openai.ts` | Create | Shape detection + translation: `detectFormat`, `normalizeOpenAICapture`, `rebuildAssistantFromOpenAISSE`. Header comment explains the OpenAI ↔ Anthropic mapping. |
| `web/src/types.ts` | Modify | Add `_format?: "openai" \| "anthropic"` to `Capture`. No other changes. |
| `web/src/lib/api.ts` | Modify | `fetchFile` post-processes raw JSON via `detectFormat` + `normalizeOpenAICapture`. |
| `web/src/components/SseTimeline.tsx` | Modify | Branch event-name labeling on `capture._format`. |
| `web/src/components/ResponseTab.tsx` | Modify | Branch the "Reassembled content blocks" rebuild on `capture._format`. |
| `web/src/components/ConversationTab.tsx` | Modify | Branch the `rebuiltAssistant` useMemo on `capture._format`. |

Unchanged: `buildConversationItems`, `Message.tsx`, `ToolPair.tsx`, `RequestTab.tsx`, `RawJsonTab.tsx`, styles, `App.tsx`.

---

## Task 1: Add `_format` to Capture type

**Files:**
- Modify: `web/src/types.ts` (the `Capture` interface, around line 107-110)

**Interfaces:**
- Produces: `Capture._format?: "openai" | "anthropic"` — read by `api.ts`, `SseTimeline.tsx`, `ResponseTab.tsx`.

- [ ] **Step 1: Edit the Capture interface**

In `web/src/types.ts`, change the `Capture` interface from:

```ts
export interface Capture {
  request?: CaptureRequest;
  response?: CaptureResponse;
}
```

to:

```ts
export interface Capture {
  request?: CaptureRequest;
  response?: CaptureResponse;
  // 协议嗅探标记：由 api.ts 在加载时注入。下游 SseTimeline / ResponseTab 据此分支。
  // Protocol sniff marker: injected by api.ts at load time. SseTimeline / ResponseTab branch on it.
  _format?: "openai" | "anthropic";
}
```

- [ ] **Step 2: Verify build still passes**

Run: `cd web && npm run build`
Expected: build succeeds with no errors (this step is purely additive; nothing reads `_format` yet).

- [ ] **Step 3: Commit**

```bash
git add web/src/types.ts
git commit -m "feat(web): add _format marker to Capture type for protocol sniffing"
```

---

## Task 2: Create `openai.ts` with shape detection

**Files:**
- Create: `web/src/lib/openai.ts`

**Interfaces:**
- Produces: `detectFormat(capture: Capture): "openai" | "anthropic"` — used by `api.ts` (Task 6).

- [ ] **Step 1: Create the module with header comment + `detectFormat`**

Create `web/src/lib/openai.ts` with this exact content:

```ts
/*
 * OpenAI-spec capture 适配层。
 *
 * 抓包层面 addon 已经记录了 /chat/completions 与 /completions 的原始字节，
 * 但 viewer 的内部模型（Message / ContentBlock / ToolUseBlock）是按 Anthropic
 * /messages 的形状设计的。本模块在 /api/file 加载时做形状嗅探与归一化翻译，
 * 让下游组件（ConversationTab / buildConversationItems / Message / ToolPair）零改动。
 *
 * Boundary adapter for OpenAI-spec captures. The addon already records raw bytes
 * for /chat/completions and /completions, but the viewer's internal model follows
 * Anthropic's /messages shape. This module sniffs and translates at /api/file
 * load time so downstream components stay unchanged.
 *
 * 翻译映射见 docs/superpowers/specs/2026-07-15-openai-completions-support-design.md
 * See the design doc for the full mapping table.
 */
import type { Capture } from "../types";

/**
 * 嗅探 capture 形状，判定是 OpenAI 规范还是 Anthropic 原生。
 * 三条件任一命中即判 OpenAI；都不命中则默认 Anthropic（历史行为）。
 *
 * Sniff the capture shape. Any one of three conditions → "openai".
 * Otherwise default to "anthropic" (historical behavior — better to under-classify
 * than to mistranslate a known shape).
 */
export function detectFormat(capture: Capture): "openai" | "anthropic" {
  const res = capture.response;
  const reqBody = capture.request?.body;

  // 1. 非流式响应体含 choices[]。
  //    Non-streaming response body contains a choices[] array.
  const bodyObj =
    res?.body && typeof res.body === "object" ? (res.body as Record<string, unknown>) : null;
  if (bodyObj && Array.isArray(bodyObj.choices)) return "openai";

  // 2. SSE 事件里有 data.choices[]。
  //    Any SSE event has data.choices[].
  const sse = res?.sse_events;
  if (sse && sse.length > 0) {
    for (const ev of sse) {
      const d = ev.data;
      if (d && typeof d === "object" && Array.isArray((d as Record<string, unknown>).choices)) {
        return "openai";
      }
    }
  }

  // 3. 请求体有 messages[].tool_calls 或 tool_call_id，且没有顶层 system。
  //    Request body has messages[].tool_calls / tool_call_id but no top-level system.
  if (reqBody && Array.isArray(reqBody.messages) && reqBody.system === undefined) {
    for (const m of reqBody.messages) {
      if (m && typeof m === "object") {
        if ("tool_calls" in m || "tool_call_id" in m) return "openai";
      }
    }
  }

  return "anthropic";
}
```

- [ ] **Step 2: Verify build**

Run: `cd web && npm run build`
Expected: succeeds. (Module is created but not yet imported anywhere — TS may warn about unused export; that's fine, build still passes.)

- [ ] **Step 3: Commit**

```bash
git add web/src/lib/openai.ts
git commit -m "feat(web): add openai.ts with detectFormat shape sniffer"
```

---

## Task 3: Implement request-side translation

**Files:**
- Modify: `web/src/lib/openai.ts` (append functions)

**Interfaces:**
- Produces: `translateOpenAIRequest(reqBody): RequestBody` — used by `normalizeOpenAICapture` (Task 5).

- [ ] **Step 1: Append the request translator**

Append to `web/src/lib/openai.ts`:

```ts
import type {
  ContentBlock,
  Message,
  RequestBody,
  TextBlock,
  ToolUseBlock,
} from "../types";

// 把 OpenAI 的 tool_calls（arguments 是 JSON 字符串）转成 Anthropic 的 tool_use 块。
// Convert OpenAI tool_calls (where arguments is a JSON string) to Anthropic tool_use blocks.
function translateToolCalls(toolCalls: unknown[]): ToolUseBlock[] {
  const out: ToolUseBlock[] = [];
  for (const raw of toolCalls) {
    if (!raw || typeof raw !== "object") continue;
    const tc = raw as Record<string, unknown>;
    const fn = tc.function as Record<string, unknown> | undefined;
    const id = typeof tc.id === "string" ? tc.id : "";
    const name = typeof fn?.name === "string" ? fn.name : "";
    // arguments 通常是 JSON 字符串；解析失败时保留原始字符串，ToolPair 仍能渲染。
    // arguments is normally a JSON string; on parse failure keep the raw string
    // so ToolPair still renders something.
    const argsRaw = typeof fn?.arguments === "string" ? fn.arguments : "";
    let input: unknown = argsRaw;
    if (argsRaw) {
      try {
        input = JSON.parse(argsRaw);
      } catch {
        /* 保留原始字符串 / keep raw string */
      }
    }
    out.push({ type: "tool_use", id, name, input });
  }
  return out;
}

// 规范化 user.content：字符串原样保留；parts[] 只取 {type:"text"} 块。
// Normalize user.content: keep strings as-is; from parts[] only carry {type:"text"} blocks.
function translateUserContent(content: unknown): Message["content"] {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const blocks: TextBlock[] = [];
    for (const p of content) {
      if (p && typeof p === "object" && (p as Record<string, unknown>).type === "text") {
        const text = (p as Record<string, { text?: unknown }>).text;
        if (typeof text === "string") blocks.push({ type: "text", text });
      }
    }
    return blocks.length > 0 ? blocks : null;
  }
  return null;
}

/**
 * 翻译 OpenAI 请求体为 Anthropic-shape：
 *   - role=system 的消息抽出来拼成顶层 system 字符串
 *   - role=tool 的消息合成 user + tool_result 块（让 buildConversationItems 的配对逻辑生效）
 *   - assistant.tool_calls → tool_use 块
 * 详见 design doc 中的 mapping table。
 *
 * Translate the OpenAI request body to Anthropic-shape:
 *   - role=system messages are pulled out and concatenated into top-level `system`
 *   - role=tool messages are synthesized as user + tool_result blocks (so
 *     buildConversationItems pairing works unchanged)
 *   - assistant.tool_calls → tool_use blocks
 */
export function translateOpenAIRequest(reqBody: RequestBody): RequestBody {
  const msgs = Array.isArray(reqBody.messages) ? reqBody.messages : [];
  const outMessages: Message[] = [];
  const systemParts: string[] = [];

  for (const m of msgs) {
    if (!m || typeof m !== "object") continue;
    const role = (m as Message).role;
    if (role === "system") {
      // system 消息内容拼成字符串，进顶层 system。
      // Concatenate system message contents into the top-level system string.
      const c = (m as Message).content;
      const text = typeof c === "string" ? c : c == null ? "" : safeStringify(c);
      if (text) systemParts.push(text);
      continue;
    }
    if (role === "tool") {
      // role=tool 的消息合成 user + tool_result 块。tool_call_id ↔ tool_use_id。
      // Synthesize a user message with a tool_result block. tool_call_id ↔ tool_use_id.
      const toolCallId = typeof (m as { tool_call_id?: unknown }).tool_call_id === "string"
        ? ((m as { tool_call_id: string }).tool_call_id)
        : "";
      outMessages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolCallId,
            content: (m as Message).content ?? null,
          },
        ],
      });
      continue;
    }
    if (role === "assistant") {
      const toolCalls = (m as { tool_calls?: unknown[] }).tool_calls;
      const blocks: ContentBlock[] = [];
      const text = translateUserContent((m as Message).content);
      if (typeof text === "string" && text.length > 0) {
        blocks.push({ type: "text", text });
      } else if (Array.isArray(text)) {
        for (const b of text) blocks.push(b);
      }
      if (Array.isArray(toolCalls)) {
        for (const tu of translateToolCalls(toolCalls)) blocks.push(tu);
      }
      outMessages.push({
        role: "assistant",
        content: blocks.length > 0 ? blocks : null,
      });
      continue;
    }
    // user / 其他：直接透传 content 规范化结果。
    // user / other: pass through with normalized content.
    outMessages.push({
      role: (role as string) || "user",
      content: translateUserContent((m as Message).content),
    });
  }

  // tools: [{type:"function", function:{name, parameters}}] → [{name, ...}]
  // 保留原始 function.parameters 以便 Raw JSON 仍可查看。
  // Rewrite tools so the "declared" counter keeps working; preserve parameters for Raw JSON.
  let tools = reqBody.tools;
  if (Array.isArray(tools)) {
    tools = tools.map((t) => {
      const fn = (t as { function?: Record<string, unknown> })?.function;
      if (fn && typeof fn.name === "string") {
        return { name: fn.name, ...(t as object) };
      }
      return t;
    });
  }

  const out: RequestBody = { ...reqBody, messages: outMessages, tools };
  if (systemParts.length > 0) {
    out.system = systemParts.join("\n\n");
  } else {
    delete out.system;
  }
  return out;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
```

- [ ] **Step 2: Verify build**

Run: `cd web && npm run build`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add web/src/lib/openai.ts
git commit -m "feat(web): translate OpenAI request body to Anthropic-shape"
```

---

## Task 4: Implement streaming SSE rebuilder

**Files:**
- Modify: `web/src/lib/openai.ts` (append function)

**Interfaces:**
- Produces: `rebuildAssistantFromOpenAISSE(events): ContentBlock[] | null` — used by `ResponseTab` (Task 7) and `ConversationTab` (via the rebuilt assistant path, unchanged).

- [ ] **Step 1: Append the SSE rebuilder**

Append to `web/src/lib/openai.ts`:

```ts
import type { SseEvent } from "../types";

// 流式片段里的 tool_call 增量：按 index 聚合 id/name/arguments 片段。
// Streaming tool_call deltas: aggregate id/name/arguments fragments by index.
interface _StreamingToolCall {
  index: number;
  id?: string;
  name?: string;
  argsBuf: string;
  firstSeen: number; // 用于输出排序 / for output ordering
}

/**
 * 从 OpenAI 的 SSE chunk 序列重建 assistant 的 content blocks。
 *
 * Reconstruct assistant content blocks from an OpenAI SSE chunk sequence.
 *
 * 规则 / Rules:
 *   - 所有 delta.content 片段拼到一个 TextBlock
 *   - delta.tool_calls[] 按 index 聚合：首个片段带 id+name，后续片段只带 arguments 片段
 *   - data === "[DONE]" 是终止符，忽略
 *   - 输出顺序固定：[TextBlock?, ...ToolUseBlocks by first-seen index]
 *     （OpenAI 实际流式里 content 先于 tool_calls，这里固定顺序，Raw JSON tab 是真相）
 *
 * Output order is fixed (text-then-tools) regardless of arrival order; the Raw JSON
 * tab preserves the original chunk sequence as ground truth.
 */
export function rebuildAssistantFromOpenAISSE(
  events: SseEvent[] | undefined,
): ContentBlock[] | null {
  if (!events || events.length === 0) return null;

  let textBuf = "";
  let textSeen = false;
  const tcByIndex = new Map<number, _StreamingToolCall>();
  const order: number[] = [];
  let seq = 0;

  for (const ev of events) {
    const d = ev.data;
    // [DONE] 终止符：data 是字符串 "[DONE]"。
    // [DONE] terminator: data is the string "[DONE]".
    if (typeof d === "string") {
      if (d.trim() === "[DONE]") continue;
      // 其它字符串 data 忽略（OpenAI 不应该出现，但兜底）。
      // Ignore other string data (shouldn't happen for OpenAI, but be safe).
      continue;
    }
    if (!d || typeof d !== "object") continue;

    const choices = (d as Record<string, unknown>).choices;
    if (!Array.isArray(choices) || choices.length === 0) continue;
    const choice0 = choices[0] as Record<string, unknown> | undefined;
    const delta = choice0?.delta as Record<string, unknown> | undefined;
    if (!delta) continue;

    if (typeof delta.content === "string" && delta.content.length > 0) {
      textBuf += delta.content;
      textSeen = true;
    }

    const tcs = delta.tool_calls;
    if (Array.isArray(tcs)) {
      for (const raw of tcs) {
        if (!raw || typeof raw !== "object") continue;
        const tc = raw as Record<string, unknown>;
        const idx = typeof tc.index === "number" ? tc.index : 0;
        let entry = tcByIndex.get(idx);
        if (!entry) {
          entry = { index: idx, argsBuf: "", firstSeen: seq++ };
          tcByIndex.set(idx, entry);
          order.push(idx);
        }
        const fn = tc.function as Record<string, unknown> | undefined;
        if (typeof tc.id === "string") entry.id = tc.id;
        if (fn && typeof fn.name === "string") entry.name = fn.name;
        if (fn && typeof fn.arguments === "string") entry.argsBuf += fn.arguments;
      }
    }
  }

  const blocks: ContentBlock[] = [];
  if (textSeen) {
    blocks.push({ type: "text", text: textBuf });
  }
  // 按 first-seen 顺序输出 tool_use 块；解析失败的 arguments 保留原始字符串。
  // Emit tool_use blocks in first-seen order; on parse failure keep raw args string.
  const sorted = [...tcByIndex.values()].sort((a, b) => a.firstSeen - b.firstSeen);
  for (const entry of sorted) {
    let input: unknown = entry.argsBuf;
    if (entry.argsBuf) {
      try {
        input = JSON.parse(entry.argsBuf);
      } catch {
        /* 保留原始字符串 / keep raw */
      }
    }
    blocks.push({
      type: "tool_use",
      id: entry.id ?? "",
      name: entry.name ?? "",
      input,
    });
  }

  if (blocks.length === 0) return null;
  return blocks;
}
```

- [ ] **Step 2: Verify build**

Run: `cd web && npm run build`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add web/src/lib/openai.ts
git commit -m "feat(web): rebuild assistant blocks from OpenAI SSE chunks"
```

---

## Task 5: Implement non-streaming response translator + top-level normalizer

**Files:**
- Modify: `web/src/lib/openai.ts` (append functions)

**Interfaces:**
- Produces: `normalizeOpenAICapture(capture): Capture` — used by `api.ts` (Task 6).

- [ ] **Step 1: Append response translator + `normalizeOpenAICapture`**

Append to `web/src/lib/openai.ts`:

```ts
import type { ContentBlock } from "../types";

/**
 * 非流式响应：choices[0].message 翻译成 ContentBlock[]，注入到 capture 上一个
 * 便于 ConversationTab 复用 Anthropic 路径的位置。
 *
 * 实现上我们把翻译结果塞进 response._openaiRebuilt，ConversationTab 不需要改
 * （它走 SSE 路径；非流式 OpenAI 响应没有 sse_events，所以 ConversationTab 看到
 * 没有 SSE 时会落到 "no assistant reply" —— 为避免这个，normalizeOpenAICapture
 * 把非流式翻译结果写进一个合成 SSE 事件，让 rebuildAssistantFromOpenAISSE 能消费）。
 *
 * Non-streaming response: translate choices[0].message into ContentBlock[].
 * To let ConversationTab / ResponseTab reuse the SSE rebuild path, we synthesize a
 * single SSE event whose data.choices[0].delta carries the full message — then
 * rebuildAssistantFromOpenAISSE consumes it uniformly.
 */
function translateNonStreamingBody(body: unknown): { sse_events?: SseEvent[] } {
  if (!body || typeof body !== "object") return {};
  const b = body as Record<string, unknown>;
  const choices = b.choices;
  if (!Array.isArray(choices) || choices.length === 0) return {};
  const choice0 = choices[0] as Record<string, unknown> | undefined;
  const msg = choice0?.message as Record<string, unknown> | undefined;
  if (!msg) return {};

  // 合成一条 SSE 事件：delta == message 的全部字段。
  // rebuildAssistantFromOpenAISSE 会从 delta.content / delta.tool_calls 重建。
  // Synthesize one SSE event: delta == the whole message object.
  // rebuildAssistantFromOpenAISSE then reads delta.content / delta.tool_calls.
  const delta: Record<string, unknown> = {};
  if (typeof msg.content === "string") delta.content = msg.content;
  if (Array.isArray(msg.tool_calls)) delta.tool_calls = msg.tool_calls;

  return {
    sse_events: [
      {
        event: undefined,
        data: { choices: [{ index: 0, delta }] },
      },
    ],
  };
}

/**
 * 顶层归一化：翻译请求体；若响应非流式且有 choices[]，合成 SSE 事件以复用流式路径。
 * 不修改原始 body —— ResponseTab 的 "Response body" 面板仍显示原始 choices 结构。
 *
 * Top-level normalizer: translate the request body; if the response is non-streaming
 * with choices[], synthesize an SSE event to reuse the streaming rebuild path.
 * The original body is preserved so ResponseTab's "Response body" panel is unaffected.
 */
export function normalizeOpenAICapture(capture: Capture): Capture {
  const next: Capture = { ...capture, _format: "openai" };

  if (capture.request) {
    next.request = {
      ...capture.request,
      body: capture.request.body
        ? translateOpenAIRequest(capture.request.body)
        : capture.request.body,
    };
  }

  if (capture.response) {
    const sse = capture.response.sse_events;
    const hasSse = Array.isArray(sse) && sse.length > 0;
    if (!hasSse) {
      const synth = translateNonStreamingBody(capture.response.body);
      if (synth.sse_events) {
        next.response = { ...capture.response, sse_events: synth.sse_events };
      }
    }
  }

  return next;
}
```

- [ ] **Step 2: Verify build**

Run: `cd web && npm run build`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add web/src/lib/openai.ts
git commit -m "feat(web): normalizeOpenAICapture ties request + response translation"
```

---

## Task 6: Wire normalization into `api.ts`

**Files:**
- Modify: `web/src/lib/api.ts:8-11` (the `fetchFile` function)

**Interfaces:**
- Consumes: `detectFormat`, `normalizeOpenAICapture` from `./openai`.
- Produces: `fetchFile` now returns a possibly-normalized `Capture` with `_format` set.

- [ ] **Step 1: Edit `fetchFile`**

Replace the entire contents of `web/src/lib/api.ts` with:

```ts
import type { Capture, ListItem } from "../types";
import { detectFormat, normalizeOpenAICapture } from "./openai";

export async function fetchFiles(): Promise<ListItem[]> {
  const res = await fetch("/api/files");
  return (await res.json()) as ListItem[];
}

export async function fetchFile(name: string): Promise<Capture> {
  const res = await fetch(`/api/file?name=${encodeURIComponent(name)}`);
  const raw = (await res.json()) as Capture;
  // OpenAI-spec capture 在加载时归一化为 Anthropic-shape，下游组件零改动。
  // Normalize OpenAI-spec captures to Anthropic-shape at load time so all
  // downstream components stay unchanged.
  if (detectFormat(raw) === "openai") {
    return normalizeOpenAICapture(raw);
  }
  return raw;
}
```

- [ ] **Step 2: Verify build**

Run: `cd web && npm run build`
Expected: succeeds.

- [ ] **Step 3: Manual smoke check with a real OpenAI capture**

If you have an opencode or other OpenAI-spec capture file on disk (in `~/.claude-capture/captures/...`), run `claude-capture` (or `cd web && npm run dev` against a running viewer), open the viewer, click that capture, and confirm:

- Conversation tab renders system/user/assistant turns and tool calls as ToolPair cards
- Request tab shows the translated Anthropic-shape request body
- Raw JSON tab still shows the **original** OpenAI shape (raw `choices` / `tool_calls` / etc.) — this is the ground truth and must be untouched

If you don't have a capture handy, proceed to Task 7 and verify end-to-end at the end.

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/api.ts
git commit -m "feat(web): normalize OpenAI captures in fetchFile"
```

---

## Task 7: Branch SseTimeline labeling on `_format`

**Files:**
- Modify: `web/src/components/SseTimeline.tsx:38-62` (the `events.map` block)

**Interfaces:**
- Consumes: `capture._format` (added Task 1).

- [ ] **Step 1: Add OpenAI-aware event labeling**

In `web/src/components/SseTimeline.tsx`, replace the `events.map(...)` callback body. Find:

```tsx
        {events.map((ev, i) => {
          const name = ev.event || "—";
          const cls = name.includes("delta")
            ? "delta"
            : name.includes("tool")
              ? "tool_use"
              : name.includes("error")
                ? "error"
                : "";
          const dataStr = typeof ev.data === "string" ? ev.data : JSON.stringify(ev.data);
          const preview =
            dataStr.length > 500
              ? `${dataStr.slice(0, 500)} … (+${dataStr.length - 500})`
              : dataStr;
          return (
            <div className="sse-item" key={i}>
              <div className="sse-idx">#{String(i).padStart(3, "0")}</div>
              <div
                className={`sse-event ${cls}`}
                dangerouslySetInnerHTML={{ __html: escapeHtml(name) }}
              />
              <div className="sse-data" dangerouslySetInnerHTML={{ __html: escapeHtml(preview) }} />
            </div>
          );
        })}
```

Replace with:

```tsx
        {events.map((ev, i) => {
          // OpenAI 的 chunk 没有 event: 字段；按 delta 结构合成一个诚实标注的名字，
          // 而不是伪造 Anthropic 事件名（避免看 raw 时被误导）。
          // OpenAI chunks carry no event: field; synthesize an honest label from the
          // delta shape instead of faking Anthropic event names (keeps raw inspection honest).
          let name: string;
          let cls: string;
          if (capture._format === "openai") {
            const derived = labelOpenAIChunk(ev);
            name = derived.name;
            cls = derived.cls;
          } else {
            name = ev.event || "—";
            cls = name.includes("delta")
              ? "delta"
              : name.includes("tool")
                ? "tool_use"
                : name.includes("error")
                  ? "error"
                  : "";
          }
          const dataStr = typeof ev.data === "string" ? ev.data : JSON.stringify(ev.data);
          const preview =
            dataStr.length > 500
              ? `${dataStr.slice(0, 500)} … (+${dataStr.length - 500})`
              : dataStr;
          return (
            <div className="sse-item" key={i}>
              <div className="sse-idx">#{String(i).padStart(3, "0")}</div>
              <div
                className={`sse-event ${cls}`}
                dangerouslySetInnerHTML={{ __html: escapeHtml(name) }}
              />
              <div className="sse-data" dangerouslySetInnerHTML={{ __html: escapeHtml(preview) }} />
            </div>
          );
        })}
```

- [ ] **Step 2: Add the `labelOpenAIChunk` helper**

At the top of `web/src/components/SseTimeline.tsx`, after the existing imports, add:

```tsx
import type { Capture, SseEvent } from "../types";

// 从 OpenAI chunk 的 data 结构派生事件名 + 颜色类。
// Derive event-name + color class from the OpenAI chunk's data shape.
function labelOpenAIChunk(ev: SseEvent): { name: string; cls: string } {
  if (typeof ev.data === "string") {
    const trimmed = ev.data.trim();
    if (trimmed === "[DONE]" || trimmed === '"[DONE]"') {
      return { name: "[DONE]", cls: "" };
    }
    return { name: "—", cls: "" };
  }
  const d = ev.data as Record<string, unknown> | undefined;
  const choices = d?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return { name: "—", cls: "" };
  const delta = (choices[0] as Record<string, unknown> | undefined)?.delta as
    | Record<string, unknown>
    | undefined;
  if (!delta) return { name: "—", cls: "" };
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
    const first = delta.tool_calls[0] as Record<string, unknown> | undefined;
    const idx = typeof first?.index === "number" ? first.index : 0;
    return { name: `delta.tool_calls[${idx}]`, cls: "tool_use" };
  }
  if (typeof delta.content === "string") {
    return { name: "delta.content", cls: "delta" };
  }
  return { name: "—", cls: "" };
}
```

If the existing import line already reads `import type { Capture } from "../types";`, change it to the two-line version above (add `SseEvent`). If not, add the new import.

- [ ] **Step 3: Verify build**

Run: `cd web && npm run build`
Expected: succeeds.

- [ ] **Step 4: Manual check**

Open an OpenAI-spec streaming capture. The SSE Timeline should now show rows labeled `delta.content`, `delta.tool_calls[0]`, `[DONE]` etc., colored the same way Anthropic deltas/tool_use are.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/SseTimeline.tsx
git commit -m "feat(web): label OpenAI SSE chunks honestly in SseTimeline"
```

---

## Task 8: Branch ResponseTab rebuild on `_format`

**Files:**
- Modify: `web/src/components/ResponseTab.tsx:2` (imports) and `:50-72` (the "Reassembled content blocks" block).

**Interfaces:**
- Consumes: `capture._format`, `rebuildAssistantFromOpenAISSE` from `../lib/openai`.

- [ ] **Step 1: Update imports**

In `web/src/components/ResponseTab.tsx`, change:

```tsx
import { rebuildAssistantFromSSE } from "../lib/sse";
```

to:

```tsx
import { rebuildAssistantFromSSE } from "../lib/sse";
import { rebuildAssistantFromOpenAISSE } from "../lib/openai";
```

- [ ] **Step 2: Branch the rebuild call**

Find this block in `ResponseTab.tsx`:

```tsx
      {sse.length > 0 &&
        (() => {
          const rebuilt = rebuildAssistantFromSSE(sse);
          if (!rebuilt) return null;
```

Replace with:

```tsx
      {sse.length > 0 &&
        (() => {
          // OpenAI 与 Anthropic 用不同的 SSE 重建器，输出都是 ContentBlock[]。
          // Both rebuilders return ContentBlock[]; branch on _format.
          const rebuilt =
            capture._format === "openai"
              ? rebuildAssistantFromOpenAISSE(sse)
              : rebuildAssistantFromSSE(sse);
          if (!rebuilt) return null;
```

- [ ] **Step 3: Verify build**

Run: `cd web && npm run build`
Expected: succeeds.

- [ ] **Step 4: Manual check**

Open an OpenAI-spec streaming capture. The Response tab's "Reassembled content blocks" section should now show the rebuilt `[TextBlock, ...ToolUseBlock]` array, mirroring what the Conversation tab renders.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/ResponseTab.tsx
git commit -m "feat(web): branch ResponseTab SSE rebuild on _format"
```

---

## Task 9: Branch ConversationTab rebuild on `_format`

**Files:**
- Modify: `web/src/components/ConversationTab.tsx:3` (imports) and `:38` (the `rebuiltAssistant` useMemo).

**Interfaces:**
- Consumes: `capture._format`, `rebuildAssistantFromOpenAISSE` from `../lib/openai`.

- [ ] **Step 1: Update imports**

In `web/src/components/ConversationTab.tsx`, change:

```tsx
import { rebuildAssistantFromSSE } from "../lib/sse";
```

to:

```tsx
import { rebuildAssistantFromSSE } from "../lib/sse";
import { rebuildAssistantFromOpenAISSE } from "../lib/openai";
```

- [ ] **Step 2: Branch the rebuild call**

Find this line in `ConversationTab.tsx`:

```tsx
  const rebuiltAssistant = useMemo(() => rebuildAssistantFromSSE(sse), [sse]);
```

Replace with:

```tsx
  // OpenAI 与 Anthropic 用不同的 SSE 重建器，输出都是 ContentBlock[]。
  // Both rebuilders return ContentBlock[]; branch on _format.
  const rebuiltAssistant = useMemo(
    () =>
      capture._format === "openai"
        ? rebuildAssistantFromOpenAISSE(sse)
        : rebuildAssistantFromSSE(sse),
    [sse, capture._format],
  );
```

- [ ] **Step 3: Verify build**

Run: `cd web && npm run build`
Expected: succeeds.

- [ ] **Step 4: Manual check**

Open an OpenAI-spec streaming capture. The Conversation tab should now render the assistant turn (text + tool calls). Without this task the assistant turn would be missing from the conversation view even though the Request/Response tabs show data.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/ConversationTab.tsx
git commit -m "feat(web): branch ConversationTab SSE rebuild on _format"
```

---

## Task 10: End-to-end regression check

**Files:** none.

- [ ] **Step 1: Build**

Run: `cd web && npm run build`
Expected: succeeds with no TS errors.

- [ ] **Step 2: OpenAI capture — full sweep**

Launch `claude-capture --claude <your-openai-cli>` (or drop a known OpenAI-shape capture JSON into `~/.claude-capture/captures/`). Open the viewer on one capture and confirm:

- **Conversation tab**: system prompt visible as a system message; user turns render; assistant turns show text + tool calls; tool calls pair with their tool_result messages as ToolPair cards.
- **SSE Timeline tab**: rows labeled `delta.content` / `delta.tool_calls[N]` / `[DONE]`.
- **Response tab**: meta table + reassembled content blocks + (if non-streaming) raw response body.
- **Request tab**: translated Anthropic-shape body (system as string, tool_use blocks, synthesized tool_result user messages).
- **Raw JSON tab**: **original** OpenAI shape unchanged (`choices`, `tool_calls`, `messages[].role:"tool"`, etc.).

- [ ] **Step 3: Anthropic capture — regression sweep**

Open a native Claude Code capture (any pre-existing one). Confirm all four tabs render exactly as before — no spurious `_format` artifacts, no broken labels. The Conversation tab should look identical to a build from before this plan.

- [ ] **Step 4: Commit (if any polish fell out)**

If steps 2–3 surfaced fixes, commit them with clear messages. Otherwise no commit needed.

---

## Self-review notes

- **Spec coverage**: every row of the mapping table in the design doc is implemented (system → top-level string, user content normalization, assistant tool_calls → tool_use, role:tool → synthesized tool_result, non-streaming choices[0].message, streaming delta accumulation, SseTimeline honest labeling, ResponseTab rebuild branch). YAGNI edges (image_url, logprobs, n>1, legacy function_call, session grouping) are intentionally absent.
- **Type consistency**: `_format` is consistently typed as `"openai" | "anthropic"` across `types.ts`, `openai.ts`, `SseTimeline.tsx`, `ResponseTab.tsx`. The `rebuildAssistantFromOpenAISSE` name is used identically in its definition (Task 4) and its consumer (Task 8).
- **No placeholders**: every step shows the actual code to write or command to run.
