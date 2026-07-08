import type { Headers } from "../types";

// 客户端脱敏：授权相关头只保留前 8 个字符。
// Client-side redaction: auth-related headers truncated to first 8 chars.
export function redactHeaders(h: Headers | undefined): Headers {
  const out: Headers = { ...(h || {}) };
  for (const k of Object.keys(out)) {
    if (/auth|x-api-key|authorization|token/i.test(k)) {
      const v = out[k];
      out[k] = (v != null ? String(v) : "").slice(0, 8) + "…";
    }
  }
  return out;
}
