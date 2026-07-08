import type { Capture, ListItem } from "../types";

export async function fetchFiles(): Promise<ListItem[]> {
  const res = await fetch("/api/files");
  return (await res.json()) as ListItem[];
}

export async function fetchFile(name: string): Promise<Capture> {
  const res = await fetch("/api/file?name=" + encodeURIComponent(name));
  return (await res.json()) as Capture;
}
