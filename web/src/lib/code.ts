import { escapeHtml } from "./format";

// 扩展名 → 语言族。仅代码类文件返回非 null，其余返回 null（调用方回退）。
// Extension → language family. Returns null for non-code files so the caller
// can fall back to its default rendering.
const CODE_LANGS: Record<string, string> = {
  ts: "ts", tsx: "ts", mts: "ts", cts: "ts",
  js: "js", jsx: "js", mjs: "js", cjs: "js",
  py: "py", pyi: "py",
  go: "go",
  rs: "rs",
  java: "java", kt: "java", kts: "java", scala: "java",
  c: "c", h: "c", cpp: "c", cc: "c", cxx: "c", hpp: "c", hh: "c",
  cs: "c",
  rb: "rb",
  php: "php",
  swift: "swift",
  sh: "sh", bash: "sh", zsh: "sh", fish: "sh",
  css: "css", scss: "css", less: "css",
  dart: "dart",
  lua: "lua",
  sql: "sql",
};

export function codeLangFromPath(path?: string): string | null {
  if (!path) return null;
  const m = path.match(/\.([a-z0-9]+)$/i);
  if (!m) return null;
  return CODE_LANGS[m[1].toLowerCase()] ?? null;
}

// 按语言族决定行注释前缀；块注释仅对 C 族开启。
// Pick the line-comment prefix per language family; block comments are only
// enabled for the C-family languages.
function lineCommentToken(lang: string): string | null {
  if (["py", "rb", "sh", "yaml", "toml", "ini", "vim", "lua"].includes(lang)) return "#";
  if (lang === "sql") return "--";
  return "//";
}
function allowsBlockComment(lang: string): boolean {
  return ["js", "ts", "java", "c", "css", "php", "swift", "rs", "go", "dart", "scala", "kt"].includes(lang);
}
function allowsBacktickString(lang: string): boolean {
  return lang === "js" || lang === "ts";
}

// 保守的关键字集合：覆盖 JS/TS/Python/Go/Rust/C 族常用保留字。
// Conservative keyword set covering common reserved words across JS/TS/Python/
// Go/Rust/C-family. Over-coloring risk is low since these are rarely identifiers.
const KEYWORDS = new Set([
  // JS/TS
  "const", "let", "var", "function", "class", "extends", "implements", "new",
  "return", "if", "else", "for", "while", "do", "switch", "case", "break",
  "continue", "throw", "try", "catch", "finally", "yield", "await", "async",
  "typeof", "instanceof", "in", "of", "void", "delete", "this", "super",
  "null", "undefined", "true", "false", "enum", "interface", "type",
  "namespace", "declare", "abstract", "readonly", "private", "protected",
  "public", "static", "get", "set", "import", "export", "from", "default",
  "as", "satisfies", "keyof", "infer", "is",
  // Python
  "def", "elif", "pass", "lambda", "assert", "with", "except", "raise",
  "global", "nonlocal", "None", "True", "False", "and", "or", "not", "self", "cls",
  // Go
  "func", "range", "go", "chan", "select", "struct", "map", "nil", "package", "defer",
  // Rust
  "fn", "mut", "loop", "match", "impl", "trait", "use", "pub", "unsafe",
  "move", "ref", "Self", "crate", "mod", "where", "dyn",
  // C/C++/Java/C#
  "int", "float", "double", "char", "unsigned", "long", "short", "signed",
  "union", "sizeof", "virtual", "override", "final", "using", "bool", "string",
]);

function span(cls: string, text: string): string {
  return `<span class="${cls}">${escapeHtml(text)}</span>`;
}

// 单行代码高亮：注释、字符串、数字、关键字。按行调用，避免跨行块重构。
// Highlight a single line of code: comments, strings, numbers, keywords.
// Called per line so multi-line constructs are intentionally out of scope.
export function highlightCode(src: string, lang: string): string {
  const out: string[] = [];
  const n = src.length;
  let i = 0;
  const lineC = lineCommentToken(lang);
  const block = allowsBlockComment(lang);
  const backtick = allowsBacktickString(lang);
  const isWord = (c: string) => /[A-Za-z0-9_$]/.test(c);

  while (i < n) {
    const c = src[i];

    // 行注释到行尾。
    // Line comment to end of line.
    if (lineC && src.startsWith(lineC, i)) {
      out.push(span("c-comment", src.slice(i)));
      i = n;
      continue;
    }

    // 单行块注释 /* ... */。
    // Single-line block comment.
    if (block && c === "/" && src[i + 1] === "*") {
      let j = i + 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
      j = Math.min(j + 2, n);
      out.push(span("c-comment", src.slice(i, j)));
      i = j;
      continue;
    }

    // 字符串：单引号/双引号/反引号（反引号仅 js/ts）。
    // Strings: single/double/backtick (backtick only for js/ts).
    if (c === '"' || c === "'" || (backtick && c === "`")) {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === quote) {
          j++;
          break;
        }
        j++;
      }
      out.push(span("c-str", src.slice(i, j)));
      i = j;
      continue;
    }

    // 数字（含十六进制、小数、指数）。前面不能是单词字符，避免匹配 var2 的 2。
    // Numbers (hex/decimal/exp). Preceded by a non-word char so the 2 in
    // "var2" is not picked up.
    if (/[0-9]/.test(c) && (i === 0 || !isWord(src[i - 1]))) {
      let j = i;
      if (c === "0" && (src[i + 1] === "x" || src[i + 1] === "X")) {
        j = i + 2;
        while (j < n && /[0-9a-fA-F_]/.test(src[j])) j++;
      } else {
        while (j < n && /[0-9_]/.test(src[j])) j++;
        if (src[j] === "." && /[0-9]/.test(src[j + 1])) {
          j++;
          while (j < n && /[0-9_]/.test(src[j])) j++;
        }
        if (src[j] === "e" || src[j] === "E") {
          j++;
          if (src[j] === "+" || src[j] === "-") j++;
          while (j < n && /[0-9_]/.test(src[j])) j++;
        }
      }
      out.push(span("c-num", src.slice(i, j)));
      i = j;
      continue;
    }

    // 单词：关键字着色，否则原样转义。
    // Word: color if keyword, otherwise escape as-is.
    if (isWord(c)) {
      let j = i;
      while (j < n && isWord(src[j])) j++;
      const w = src.slice(i, j);
      out.push(KEYWORDS.has(w) ? span("c-kw", w) : escapeHtml(w));
      i = j;
      continue;
    }

    out.push(escapeHtml(c));
    i++;
  }
  return out.join("");
}

// 渲染 Read 工具返回的带行号文件内容：剥除 "N\t" 前缀，按行高亮，左侧行号槽。
// Render a Read tool result (line-numbered file content): strip the "N\t"
// prefix, highlight each line, and show line numbers in a left gutter.
// Returns null when the file type isn't recognized as code so the caller can
// fall back to its default rendering.
export function renderCodeFile(text: string, filePath?: string): string | null {
  const lang = codeLangFromPath(filePath);
  if (!lang) return null;
  const lines = text.split("\n");
  const rows = lines
    .map((line) => {
      const m = line.match(/^(\d+)\t([\s\S]*)$/);
      if (m) {
        const num = m[1];
        const code = m[2];
        return `<div class="code-row"><span class="code-ln">${escapeHtml(num)}</span><span class="code-src">${highlightCode(code, lang)}</span></div>`;
      }
      return `<div class="code-row"><span class="code-ln"></span><span class="code-src">${highlightCode(line, lang)}</span></div>`;
    })
    .join("");
  return `<div class="code-file" data-lang="${escapeHtml(lang)}">${rows}</div>`;
}
