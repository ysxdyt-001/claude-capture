import type { ListItem } from "../types";

// 树节点：session（目录）或 leaf（单条 capture）。depth 用于渲染缩进。
// Tree node: a session (directory) or a leaf (single capture). depth drives render indent.
export interface TreeNode {
  type: "session" | "leaf";
  depth: number; // 0 = top-level session; 1 = direct leaf; 2+ = future nested
  key: string; // unique key (React list + collapse state)
  name: string; // full path for leaves; session dirname for sessions
  // session-only:
  captures?: ListItem[];
  newestMtime?: number;
  // leaf-only:
  item?: ListItem;
}

const UNGROUPED = "ungrouped";

// 把扁平的 ListItem[] 组织成 TreeNode 树。
// 今天只产生 2 层（session 深度 0 + 叶子深度 1）；未来嵌套路径只需扩展本函数。
// Organize a flat ListItem[] into a TreeNode tree.
// Today emits 2 levels (session depth 0 + leaves depth 1); future nested paths only extend this function.
export function buildTree(items: ListItem[]): TreeNode[] {
  const buckets = new Map<string, ListItem[]>();
  for (const it of items) {
    const slashIdx = it.name.indexOf("/");
    const key = slashIdx === -1 ? UNGROUPED : it.name.slice(0, slashIdx);
    const arr = buckets.get(key);
    if (arr) arr.push(it);
    else buckets.set(key, [it]);
  }

  const sessions: TreeNode[] = [];
  for (const [key, captures] of buckets) {
    // 服务器已按 mtime desc 排序；组内顺序保留。
    // Server already sorts by mtime desc; preserve within-group order.
    let newest = 0;
    for (const c of captures) if (c.mtime > newest) newest = c.mtime;
    sessions.push({
      type: "session",
      depth: 0,
      key,
      name: key,
      captures,
      newestMtime: newest,
    });
  }

  // 组间按最新 mtime desc，让最近的 session 排最上面。
  // Sort sessions by newest mtime desc so the most recent is on top.
  sessions.sort((a, b) => (b.newestMtime ?? 0) - (a.newestMtime ?? 0));
  return sessions;
}

// 把树展平成可见行的数组：跳过被折叠 session 的子节点。
// Flatten the tree into the visible-rows array: skip children of collapsed sessions.
// 今天子节点都是叶子；未来嵌套路径需要把内层循环改成递归遍历。
// Today children are all leaves; future nested paths require turning the inner loop into a recursive walk.
export function flattenVisible(tree: TreeNode[], collapsedKeys: Set<string>): TreeNode[] {
  const out: TreeNode[] = [];
  for (const node of tree) {
    out.push(node);
    if (node.type === "session" && !collapsedKeys.has(node.key) && node.captures) {
      for (const c of node.captures) {
        out.push({ type: "leaf", depth: node.depth + 1, key: c.name, name: c.name, item: c });
      }
    }
  }
  return out;
}
