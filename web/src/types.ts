// 抓包数据的 TypeScript 类型定义，对应 addon.py 的输出结构。
// Types matching the capture JSON shape produced by lib/addon.py.

export type Headers = Record<string, string>;

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultContentText {
  type: "text";
  text: string;
}

export interface ToolResultContentImage {
  type: "image";
  source?: { type?: string };
}

export interface ToolResultContentToolUse {
  type: "tool_use";
  [k: string]: unknown;
}

export type ToolResultContent =
  | ToolResultContentText
  | ToolResultContentImage
  | ToolResultContentToolUse
  | Record<string, unknown>;

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  is_error?: boolean;
  content: string | ToolResultContent[] | Record<string, unknown> | null;
}

export interface ImageBlock {
  type: "image";
  source?: { type?: string };
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | ImageBlock
  | { type: string; [k: string]: unknown };

export interface Message {
  role: "user" | "assistant" | "system" | string;
  content: string | ContentBlock[] | Record<string, unknown> | null;
  fromSSE?: boolean;
}

export interface Tool {
  name?: string;
  function?: { name?: string };
  [k: string]: unknown;
}

export interface RequestBody {
  model?: string;
  system?: string | object;
  messages?: Message[];
  tools?: Tool[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  [k: string]: unknown;
}

export interface CaptureRequest {
  url?: string;
  method?: string;
  headers?: Headers;
  body?: RequestBody;
}

export interface SseEvent {
  event?: string;
  data?: object | string;
}

export interface CaptureResponse {
  status_code?: number;
  status?: number;
  headers?: Headers;
  body?: unknown;
  sse_events?: SseEvent[];
}

export interface Capture {
  request?: CaptureRequest;
  response?: CaptureResponse;
}

export interface ListItem {
  name: string;
  mtime: number;
  size: number;
  status?: number;
  preview: string;
  tag?: string; // "main" | "subagent" | "explore" | "utility" | "unknown"
}
