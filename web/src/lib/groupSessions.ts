import type { ListItem } from "../types";

// 一个会话分组：同一 session-<id>/ 目录下的所有 capture。
// A session group: all captures written under the same session-<id>/ subdirectory.
export interface SessionGroup {
  key: string; // name.split("/")[0]; "ungrouped" for flat captures
  captures: ListItem[]; // sorted by mtime desc (server order preserved within group)
  newestMtime: number; // max mtime in the group — drives group ordering
  openingPreview: string; // oldest capture's preview — the session's first user message
}

const UNGROUPED = "ungrouped";

// 把扁平的 ListItem[] 按路径首段（session id）分桶。
// Bucket a flat ListItem[] by the first path segment (the session id).
export function groupSessionsByPath(items: ListItem[]): SessionGroup[] {
  const buckets = new Map<string, ListItem[]>();
  for (const it of items) {
    const slashIdx = it.name.indexOf("/");
    const key = slashIdx === -1 ? UNGROUPED : it.name.slice(0, slashIdx);
    const arr = buckets.get(key);
    if (arr) arr.push(it);
    else buckets.set(key, [it]);
  }

  const groups: SessionGroup[] = [];
  for (const [key, captures] of buckets) {
    // 服务器已经按 mtime desc 排序，组内顺序保留。
    // Server already sorts by mtime desc; preserve within-group order.
    let newest = 0;
    for (const c of captures) if (c.mtime > newest) newest = c.mtime;
    // captures[length-1] 是组里最旧的一条（因为 desc 排序），其 preview 即开场消息。
    // captures[length-1] is the oldest in the group (desc order); its preview is the opening message.
    const opening = captures.length > 0 ? captures[captures.length - 1].preview : "";
    groups.push({ key, captures, newestMtime: newest, openingPreview: opening });
  }

  // 组间按最新 mtime desc，确保最近的 session 排在最上面。
  // Sort groups by newest mtime desc so the most recent session is on top.
  groups.sort((a, b) => b.newestMtime - a.newestMtime);
  return groups;
}
