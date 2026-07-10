import { escapeHtml } from "./format";

// 已知 shell 关键字（控制流 + 常用内建命令），用于关键字高亮。
// Known shell keywords (control flow + common builtins) for keyword highlighting.
const SHELL_KEYWORDS = new Set([
  "if", "then", "elif", "else", "fi", "for", "in", "do", "done", "while",
  "until", "case", "esac", "function", "return", "export", "local",
  "readonly", "unset", "shift", "source", "exec", "eval", "echo", "printf",
  "read", "set", "declare", "typeset", "trap", "exit", "cd", "command",
  "builtin", "alias", "unalias", "true", "false", "bg", "fg", "jobs",
  "kill", "wait", "time", "umask", "continue", "break", "select",
]);

const isWordChar = (c: string) => /[A-Za-z0-9_./]/.test(c);
const isVarChar = (c: string) => /[A-Za-z0-9_]/.test(c);

function span(cls: string, text: string): string {
  return `<span class="${cls}">${escapeHtml(text)}</span>`;
}

// 依赖最小的 shell 语法高亮器：注释、字符串、运算符、关键字、变量。
// 全部在原始字符串上分词，每个 token 单独转义后输出，避免二次转义。
// Minimal, dependency-free shell syntax highlighter: comments, strings,
// operators, keywords, variables. Tokenizes the raw string and escapes each
// emitted token individually so nothing is double-escaped.
export function highlightShell(src: string): string {
  const out: string[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];

    // 行注释 # ... 到行尾。
    // Line comment: # ... to end of line.
    if (c === "#") {
      let j = i + 1;
      while (j < n && src[j] !== "\n") j++;
      out.push(span("sh-comment", src.slice(i, j)));
      i = j;
      continue;
    }

    // 双引号字符串（含转义）。
    // Double-quoted string with escapes.
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === '"') {
          j++;
          break;
        }
        j++;
      }
      out.push(span("sh-str", src.slice(i, j)));
      i = j;
      continue;
    }

    // 单引号字符串（无转义）。
    // Single-quoted string (no escaping inside).
    if (c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== "'") j++;
      if (j < n) j++; // 闭合引号 / closing quote
      out.push(span("sh-str", src.slice(i, j)));
      i = j;
      continue;
    }

    // 变量引用 $VAR / ${VAR}。
    // Variable reference $VAR / ${VAR}.
    if (c === "$") {
      let j = i + 1;
      if (src[j] === "{") {
        while (j < n && src[j] !== "}") j++;
        if (j < n) j++; // 闭合花括号 / closing brace
      } else {
        while (j < n && isVarChar(src[j])) j++;
      }
      // 只有 "$" 孤立时（行尾或后接非变量字符），按普通字符输出。
      // A lone "$" (end of string or non-var follower) renders as plain text.
      if (j > i + 1) {
        out.push(span("sh-var", src.slice(i, j)));
        i = j;
        continue;
      }
    }

    // 双字符运算符优先于单字符。
    // Two-char operators checked before single-char ones.
    const two = src.slice(i, i + 2);
    if (
      two === "&&" ||
      two === "||" ||
      two === ">>" ||
      two === "<<" ||
      two === ";;" ||
      two === "&>" ||
      two === ">|" ||
      two === "<&" ||
      two === ">&" ||
      two === "<>"
    ) {
      out.push(span("sh-op", two));
      i += 2;
      continue;
    }

    // 单字符运算符。
    // Single-char operators.
    if ("|;()<>&".includes(c)) {
      out.push(span("sh-op", c));
      i++;
      // 仅在 ; 后换行；管道 | 保持同行。换行时吃掉 ; 后的一个空格，
      // 否则它会变成下一行的前导空格，让后续行比首行多缩进一格。
      // Break only after ; ; keep pipelines (|) on one line. Consume the
      // single space after ; so it doesn't become a leading space on the
      // next row and misalign it from the first row.
      if (c === ";") {
        out.push("\n");
        if (src[i] === " ") i++;
      }
      continue;
    }

    // 单词：内建命令/可执行名/路径/标识符。
    // Word: builtin / executable / path / identifier.
    if (isWordChar(c)) {
      let j = i;
      while (j < n && isWordChar(src[j])) j++;
      const w = src.slice(i, j);
      if (SHELL_KEYWORDS.has(w)) {
        out.push(span("sh-kw", w));
      } else {
        out.push(escapeHtml(w));
      }
      i = j;
      continue;
    }

    // 其他字符（空格、换行、反引号等）原样转义输出。
    // Everything else (whitespace, backticks, ...) escaped as-is.
    out.push(escapeHtml(c));
    i++;
  }
  return out.join("");
}
