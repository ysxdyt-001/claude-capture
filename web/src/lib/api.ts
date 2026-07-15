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
