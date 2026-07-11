export function escapeHtml(s: unknown): string {
  if (s == null) return "";
  return String(s).replace(
    /[&<>"']/g,
    (ch) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[ch] as string,
  );
}

export function unescapeHtml(s: string): string {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function formatTime(ms?: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const time = d.toLocaleTimeString("zh-CN", { hour12: false });
  return `${date} ${time}`;
}

// 相对时间：5 分钟前 / 3 小时前 / 昨天 / 3 天前。超过 7 天回退为绝对时间 MM-DD HH:mm。
// Relative time via Intl.RelativeTimeFormat. Falls back to absolute date past 7 days.
export function relativeTime(ms?: number): string {
  if (!ms) return "—";
  const diff = ms - Date.now();
  const absSec = Math.abs(diff) / 1000;
  const rtf = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });

  if (absSec < 60) return rtf.format(Math.round(diff / 1000), "second");
  if (absSec < 3600) return rtf.format(Math.round(diff / 60000), "minute");
  if (absSec < 86400) return rtf.format(Math.round(diff / 3600000), "hour");
  if (absSec < 86400 * 7) return rtf.format(Math.round(diff / 86400000), "day");

  // 超过一周：绝对时间。
  // Past one week: absolute time.
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

// 把预览文本截断到 max 字符（含末尾省略号）。默认 max = 60。
// Truncate a preview string to max chars (including trailing ellipsis). Default max = 60.
export function truncatePreview(s: string, max = 60): string {
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
