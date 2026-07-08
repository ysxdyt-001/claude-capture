import { highlightJSON } from "../lib/json";

interface JsonBlockProps {
  value: unknown;
  variant?: "block" | "raw"; // block = j-block (boxed), raw = json (plain pre)
}

export default function JsonBlock({ value, variant = "block" }: JsonBlockProps) {
  const json = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const html = highlightJSON(json);
  const cls = variant === "block" ? "json j-block" : "json";
  return <pre className={cls} dangerouslySetInnerHTML={{ __html: html }} />;
}
