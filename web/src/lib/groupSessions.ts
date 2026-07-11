import type { ListItem } from "../types";

// 会话侧边栏的树节点：session → conversation/utility → leaf（turn 或 utility capture）。
// 用判别联合（node.type）让渲染端的类型收窄自然落地。
// Sidebar tree nodes: session → conversation/utility → leaf (turn or utility capture).
// Discriminated union (node.type) so the renderer narrows naturally.

export interface SessionNode {
  type: "session";
  depth: number;            // 0
  key: string;              // session key (directory prefix)
  name: string;             // session dirname
  conversations: ConversationHeaderNode[]; // newest-first by endTime
  utilityBucket: ListItem[];               // utility-tagged captures, oldest-first
  utilityKey: string;       // `${key}#utility` — collapse key for the utility bucket
  newestMtime: number;      // for cross-session sort
  captureCount: number;     // conversations + utility, for the header badge
}

export interface ConversationHeaderNode {
  type: "conversation";
  depth: number;            // 1
  key: string;              // `${sessionKey}#${anchorCaptureName}`
  anchorItem: ListItem;     // the anchor capture; rendered as the header
  turns: ListItem[];        // continuation captures only, oldest-first
  turnCount: number;        // turns.length + 1 (the anchor counts as turn 1)
  startTime: number;        // anchorItem.mtime
  endTime: number;          // last turn mtime, or anchor mtime if no turns
  tag?: string;             // inherited from anchorItem.tag
}

export interface UtilityBucketNode {
  type: "utility";
  depth: number;            // 1
  key: string;              // `${sessionKey}#utility`
  captures: ListItem[];     // oldest-first
}

export interface LeafNode {
  type: "leaf";
  depth: number;            // 2 (under a conversation or utility bucket)
  key: string;              // capture filename (stable across polls)
  name: string;
  item: ListItem;
}

export type TreeNode = SessionNode | ConversationHeaderNode | UtilityBucketNode | LeafNode;

const UNGROUPED = "ungrouped";

// 模块级缓存：相同 key 且底层 ListItem 引用未变 → 复用同一个 wrapper 节点。
// 下游 TreeNodeRow 的 memo() 依赖这个引用稳定性来跳过未变行的重渲染。
// Module-level caches: same key AND underlying ListItem refs unchanged → reuse the same
// wrapper node. Downstream TreeNodeRow's memo() relies on this identity stability.
const sessionCache = new Map<string, SessionNode>();
const conversationCache = new Map<string, ConversationHeaderNode>();
const leafCache = new Map<string, LeafNode>();
const utilityCache = new Map<string, UtilityBucketNode>();

function itemsEqual(a: ListItem[], b: ListItem[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function getOrCreateLeaf(item: ListItem, depth: number): LeafNode {
  let leaf = leafCache.get(item.name);
  if (!leaf || leaf.item !== item || leaf.depth !== depth) {
    leaf = { type: "leaf", depth, key: item.name, name: item.name, item };
    leafCache.set(item.name, leaf);
  }
  return leaf;
}

function getOrCreateConversation(
  sessionKey: string,
  anchor: ListItem,
  turns: ListItem[]
): ConversationHeaderNode {
  const key = `${sessionKey}#${anchor.name}`;
  const cached = conversationCache.get(key);
  if (cached && cached.anchorItem === anchor && itemsEqual(cached.turns, turns)) {
    return cached;
  }
  const conv: ConversationHeaderNode = {
    type: "conversation",
    depth: 1,
    key,
    anchorItem: anchor,
    turns,
    turnCount: turns.length + 1,
    startTime: anchor.mtime,
    endTime: turns.length ? turns[turns.length - 1].mtime : anchor.mtime,
    tag: anchor.tag,
  };
  conversationCache.set(key, conv);
  return conv;
}

function getOrCreateUtility(key: string, captures: ListItem[]): UtilityBucketNode {
  const cached = utilityCache.get(key);
  if (cached && itemsEqual(cached.captures, captures)) {
    return cached;
  }
  const bucket: UtilityBucketNode = {
    type: "utility",
    depth: 1,
    key,
    captures,
  };
  utilityCache.set(key, bucket);
  return bucket;
}

function getOrCreateSession(
  key: string,
  conversations: ConversationHeaderNode[],
  utilityBucket: ListItem[],
  newestMtime: number,
  captureCount: number
): SessionNode {
  const cached = sessionCache.get(key);
  if (
    cached &&
    itemsEqualSessions(cached.conversations, conversations) &&
    itemsEqual(cached.utilityBucket, utilityBucket) &&
    cached.captureCount === captureCount
  ) {
    return cached;
  }
  const session: SessionNode = {
    type: "session",
    depth: 0,
    key,
    name: key,
    conversations,
    utilityBucket,
    utilityKey: `${key}#utility`,
    newestMtime,
    captureCount,
  };
  sessionCache.set(key, session);
  return session;
}

// itemsEqualSessions: 引用比较 conversation 节点数组（conversation 节点本身已通过缓存稳定）。
// itemsEqualSessions: reference-compare conversation node arrays (the conversation nodes
// themselves are already stabilized via the cache).
function itemsEqualSessions(a: ConversationHeaderNode[], b: ConversationHeaderNode[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// 把扁平的 ListItem[] 组织成 3 层树：session → conversation → turns，外加 utility 桶。
// 同一 session 内：按 mtime 升序遍历，anchor 开新对话，continuation 追加；utility 单独入桶。
// Organize a flat ListItem[] into a 3-level tree: session → conversation → turns, plus a
// utility bucket. Within a session: walk oldest-first, anchor starts a new conversation,
// continuation appends; utility captures go into a separate bucket.
export function buildTree(items: ListItem[]): TreeNode[] {
  // 1. 按 session key 分桶（保留第一个 '/' 切分，兼容无 '/' 的裸文件名）。
  // 1. Bucket by session key (split on first '/'; tolerate bare filenames).
  const sessionBuckets = new Map<string, ListItem[]>();
  for (const it of items) {
    const slashIdx = it.name.indexOf("/");
    const key = slashIdx === -1 ? UNGROUPED : it.name.slice(0, slashIdx);
    const arr = sessionBuckets.get(key);
    if (arr) arr.push(it);
    else sessionBuckets.set(key, [it]);
  }

  const sessions: SessionNode[] = [];
  for (const [key, captures] of sessionBuckets) {
    // 2. 把 utility 单独拎出来，不参与对话分组。
    // 2. Pull utility captures aside; they don't participate in conversation grouping.
    const conversational = captures.filter((c) => c.tag !== "utility");
    const utility = captures.filter((c) => c.tag === "utility");

    // 3. 对话用 capture 按 mtime 升序，便于按时间顺序遍历分组。
    // 3. Conversational captures oldest-first so grouping walks in chronological order.
    const sorted = [...conversational].sort((a, b) => a.mtime - b.mtime);

    const conversations: ConversationHeaderNode[] = [];
    let current: { anchor: ListItem; turns: ListItem[] } | null = null;
    for (const c of sorted) {
      const isContinuation = c.kind === "continuation";
      if (!isContinuation) {
        // anchor（或 kind 缺失 —— 旧文件向后兼容）→ 关闭上一个对话，开启新对话。
        // anchor (or missing kind — backward compat) → close previous, start new.
        if (current) conversations.push(getOrCreateConversation(key, current.anchor, current.turns));
        current = { anchor: c, turns: [] };
      } else {
        // continuation → 追加到当前对话；孤儿续轮（理论上不会出现）当作 anchor 处理。
        // continuation → append; orphan continuation (shouldn't happen) treated as anchor.
        if (!current) current = { anchor: c, turns: [] };
        else current.turns.push(c);
      }
    }
    if (current) conversations.push(getOrCreateConversation(key, current.anchor, current.turns));

    // 4. 对话按 endTime 降序（最近对话排最上）。
    // 4. Conversations newest-first by endTime.
    conversations.sort((a, b) => b.endTime - a.endTime);

    // 5. Utility 桶按 mtime 升序。
    // 5. Utility bucket oldest-first.
    const sortedUtility = [...utility].sort((a, b) => a.mtime - b.mtime);

    let newest = 0;
    for (const c of captures) if (c.mtime > newest) newest = c.mtime;

    sessions.push(
      getOrCreateSession(key, conversations, sortedUtility, newest, captures.length)
    );
  }

  // session 间按最新 mtime 降序，让最近的 session 排最上面。
  // Sessions newest-first so the most recent is on top.
  sessions.sort((a, b) => b.newestMtime - a.newestMtime);
  return sessions;
}

// 把树展平成可见行数组：跳过被折叠 session / conversation / utility 桶的子节点。
// 每个子节点通过对应缓存拿到稳定引用，保住下游 memo。
// Flatten the tree into visible rows: skip children of collapsed session / conversation /
// utility bucket. Each child is resolved through its cache to preserve identity.
export function flattenVisible(tree: TreeNode[], collapsedKeys: Set<string>): TreeNode[] {
  const out: TreeNode[] = [];
  for (const node of tree) {
    out.push(node);
    if (node.type !== "session") continue;
    if (collapsedKeys.has(node.key)) continue;

    // 对话（最新在前）。
    // Conversations (newest-first).
    for (const conv of node.conversations) {
      out.push(conv);
      if (collapsedKeys.has(conv.key)) continue;
      // 续轮叶子（最旧在前）。
      // Turn leaves (oldest-first).
      for (const turn of conv.turns) {
        out.push(getOrCreateLeaf(turn, 2));
      }
    }

    // Utility 桶（仅当非空）。
    // Utility bucket (only when non-empty).
    if (node.utilityBucket.length > 0) {
      out.push(getOrCreateUtility(node.utilityKey, node.utilityBucket));
      if (!collapsedKeys.has(node.utilityKey)) {
        for (const u of node.utilityBucket) {
          out.push(getOrCreateLeaf(u, 2));
        }
      }
    }
  }
  return out;
}
