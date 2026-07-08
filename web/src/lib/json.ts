import { escapeHtml } from "./format";

export function looksLikeJSON(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

// 基于词法分析的 JSON 高亮器。输入为原始 JSON 字符串，输出 HTML。
// Tokenizer-based JSON syntax highlighter. Input is raw JSON string; output is HTML.
export function highlightJSON(jsonStr: string | object): string {
  const json =
    typeof jsonStr === "string" ? jsonStr : JSON.stringify(jsonStr, null, 2);
  let out = "";
  let i = 0;
  const n = json.length;
  const isKey = (idx: number) => {
    let k = idx;
    while (k < n && (json[k] === " " || json[k] === "\t")) k++;
    return json[k] === ":";
  };
  while (i < n) {
    const ch = json[i];
    if (ch === '"') {
      let end = i + 1;
      while (end < n) {
        if (json[end] === "\\") {
          end += 2;
          continue;
        }
        if (json[end] === '"') break;
        end++;
      }
      const lit = json.slice(i, end + 1);
      const key = isKey(end + 1);
      out += `<span class="${key ? "j-key" : "j-str"}">${escapeHtml(lit)}</span>`;
      i = end + 1;
      continue;
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      let end = i;
      while (end < n && /[-+0-9.eE]/.test(json[end])) end++;
      out += `<span class="j-num">${escapeHtml(json.slice(i, end))}</span>`;
      i = end;
      continue;
    }
    if (json.startsWith("true", i)) {
      out += '<span class="j-bool">true</span>';
      i += 4;
      continue;
    }
    if (json.startsWith("false", i)) {
      out += '<span class="j-bool">false</span>';
      i += 5;
      continue;
    }
    if (json.startsWith("null", i)) {
      out += '<span class="j-null">null</span>';
      i += 4;
      continue;
    }
    if (ch === "{" || ch === "}" || ch === "[" || ch === "]") {
      out += `<span class="j-brace">${escapeHtml(ch)}</span>`;
      i++;
      continue;
    }
    if (ch === "," || ch === ":") {
      out += `<span class="j-punct">${escapeHtml(ch)}</span>`;
      i++;
      continue;
    }
    out += escapeHtml(ch);
    i++;
  }
  return out;
}
