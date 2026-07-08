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
  return d.toLocaleTimeString("zh-CN", { hour12: false });
}
