import { escapeHtml, unescapeHtml } from "./format";
import { highlightJSON, looksLikeJSON } from "./json";

// 智能渲染：检测 JSON，否则走 markdown。
// Smart per-content renderer: detect JSON, otherwise fall back to markdown.
export function smartRender(s: unknown): string {
  if (s == null) return "";
  const str = String(s);
  const trimmed = str.trim();
  if (!trimmed) return "";
  if (/^[{[]/.test(trimmed) && looksLikeJSON(trimmed)) {
    return `<div class="j-block-wrap"><pre class="j-block">${highlightJSON(
      JSON.stringify(JSON.parse(trimmed), null, 2),
    )}</pre></div>`;
  }
  return renderMarkdown(str);
}

// 极简、无依赖的 markdown 渲染器。
// Minimal, dependency-free markdown renderer.
export function renderMarkdown(src: string): string {
  if (!src) return "";
  const escaped = escapeHtml(src);
  const stash: string[] = [];
  const keep = (html: string) => {
    stash.push(html);
    return `\u0000${stash.length - 1}\u0000`;
  };

  let text = escaped;
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang: string, code: string) => {
    const cleanCode = code.replace(/\n$/, "");
    const lowLang = (lang || "").toLowerCase();
    if (lowLang === "json") {
      const raw = unescapeHtml(cleanCode);
      return keep(
        `<pre class="md-code j-block" data-lang="json"><code>${highlightJSON(
          raw,
        )}</code></pre>`,
      );
    }
    return keep(`<pre class="md-code" data-lang="${lang}"><code>${cleanCode}</code></pre>`);
  });
  text = text.replace(/`([^`\n]+)`/g, (_, code: string) =>
    keep(`<code class="md-inline">${code}</code>`),
  );

  const lines = text.split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let list: { type: "ul" | "ol"; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length > 0) {
      out.push(`<p class="md-p">${para.join("<br>")}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(
        `<${list.type} class="md-list">${list.items
          .map((i) => `<li>${inlineFmt(i)}</li>`)
          .join("")}</${list.type}>`,
      );
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    const m = line.match(/^\u0000(\d+)\u0000$/);
    if (m) {
      flushPara();
      flushList();
      out.push(stash[Number(m[1])]);
      continue;
    }
    if (line === "") {
      flushPara();
      flushList();
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      flushList();
      const lvl = h[1].length;
      out.push(`<h${lvl} class="md-h md-h${lvl}">${inlineFmt(h[2])}</h${lvl}>`);
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      flushPara();
      flushList();
      out.push(`<hr class="md-hr">`);
      continue;
    }
    if (/^&gt;\s?/.test(line)) {
      flushPara();
      flushList();
      out.push(
        `<blockquote class="md-quote">${inlineFmt(
          line.replace(/^&gt;\s?/, ""),
        )}</blockquote>`,
      );
      continue;
    }
    const ul = line.match(/^[-*+]\s+(.*)$/);
    if (ul) {
      flushPara();
      if (!list || list.type !== "ul") {
        flushList();
        list = { type: "ul", items: [] };
      }
      list.items.push(ul[1]);
      continue;
    }
    const ol = line.match(/^\d+[.)]\s+(.*)$/);
    if (ol) {
      flushPara();
      if (!list || list.type !== "ol") {
        flushList();
        list = { type: "ol", items: [] };
      }
      list.items.push(ol[1]);
      continue;
    }
    flushList();
    para.push(inlineFmt(line));
  }
  flushPara();
  flushList();

  return out.join("\n").replace(/\u0000(\d+)\u0000/g, (_, i: string) => stash[Number(i)]);
}

export function inlineFmt(s: string): string {
  return s
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>")
    .replace(
      /\[([^\]]+)\]\(([^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>',
    )
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => `\u0000${i}\u0000`);
}
