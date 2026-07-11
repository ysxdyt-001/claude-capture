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
  conversations: ConversationHeaderNode[]; // top-level conversations, newest-first by endTime
  nestedByParent: Map<string, ConversationHeaderNode[]>; // parent capture name → nested subagent conversations
  utilityBucket: ListItem[];               // utility-tagged captures, oldest-first
  utilityKey: string;       // `${key}#utility` — collapse key for the utility bucket
  newestMtime: number;      // for cross-session sort
  captureCount: number;     // conversations + nested + utility, for the header badge
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

export interface DividerNode {
  type: "divider";
  depth: number;            // matches the turn-leaf depth where the divider sits (2 for main thread)
  key: string;              // `${captureName}#divider`
  label: string;            // "context compressed"
}

export type TreeNode = SessionNode | ConversationHeaderNode | UtilityBucketNode | LeafNode | DividerNode;

const UNGROUPED = "ungrouped";

// 模块级缓存：相同 key 且底层 ListItem 引用未变 → 复用同一个 wrapper 节点。
// 下游 TreeNodeRow 的 memo() 依赖这个引用稳定性来跳过未变行的重渲染。
// Module-level caches: same key AND underlying ListItem refs unchanged → reuse the same
// wrapper node. Downstream TreeNodeRow's memo() relies on this identity stability.
const sessionCache = new Map<string, SessionNode>();
const conversationCache = new Map<string, ConversationHeaderNode>();
const leafCache = new Map<string, LeafNode>();
const utilityCache = new Map<string, UtilityBucketNode>();
const dividerCache = new Map<string, DividerNode>();

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
  turns: ListItem[],
  depth: number
): ConversationHeaderNode {
  const key = `${sessionKey}#${anchor.name}`;
  const cached = conversationCache.get(key);
  if (cached && cached.anchorItem === anchor && itemsEqual(cached.turns, turns) && cached.depth === depth) {
    return cached;
  }
  const conv: ConversationHeaderNode = {
    type: "conversation",
    depth,
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

function getOrCreateDivider(captureName: string, depth: number, label: string): DividerNode {
  const key = `${captureName}#divider`;
  const cached = dividerCache.get(key);
  if (cached && cached.depth === depth && cached.label === label) return cached;
  const divider: DividerNode = { type: "divider", depth, key, label };
  dividerCache.set(key, divider);
  return divider;
}

function getOrCreateSession(
  key: string,
  conversations: ConversationHeaderNode[],
  nestedByParent: Map<string, ConversationHeaderNode[]>,
  utilityBucket: ListItem[],
  newestMtime: number,
  captureCount: number
): SessionNode {
  const cached = sessionCache.get(key);
  if (
    cached &&
    itemsEqualSessions(cached.conversations, conversations) &&
    nestedMapsEqual(cached.nestedByParent, nestedByParent) &&
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
    nestedByParent,
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

// nestedMapsEqual: 比较 nestedByParent 两个 Map —— 键相同 + 每个键下的对话数组引用一致。
// nestedMapsEqual: compare two nestedByParent Maps — same keys + reference-identical conversation arrays.
function nestedMapsEqual(
  a: Map<string, ConversationHeaderNode[]>,
  b: Map<string, ConversationHeaderNode[]>
): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const bv = b.get(k);
    if (!bv || !itemsEqualSessions(v, bv)) return false;
  }
  return true;
}

// 把扁平的 ListItem[] 组织成树：session → conversation → turns，外加 utility 桶。
// 同一 session 内：按 mtime 升序遍历，anchor 开新对话，continuation/compressed 追加；utility 单独入桶。
// 带 parentId 的子代理对话在遍历后从顶层移入 nestedByParent，嵌套到对应的主代理 turn 下。
// Organize a flat ListItem[] into a tree: session → conversation → turns, plus a utility bucket.
// Within a session: walk oldest-first, anchor starts a new conversation, continuation/compressed
// append; utility captures go into a separate bucket. Subagent conversations whose anchor has
// parentId are moved from top-level into nestedByParent, nesting under the originating turn.
export function buildTree(items: ListItem[]): TreeNode[] {
  // 1. 按 session key 分桶。
  // 1. Bucket by session key.
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
    // 2. 分离 utility。
    // 2. Pull utility aside.
    const conversational = captures.filter((c) => c.tag !== "utility");
    const utility = captures.filter((c) => c.tag === "utility");

    // 3. 对话用 capture 按 mtime 升序。
    // 3. Conversational captures oldest-first.
    const sorted = [...conversational].sort((a, b) => a.mtime - b.mtime);

    // 4. 走 anchor/continuation/compressed 分组。
    //    关键：continuation 和 compressed 都追加到当前对话；只有 anchor 开新对话。
    // 4. Walk anchor/continuation/compressed grouping.
    //    Key: both continuation and compressed append to the current conversation;
    //    only anchor starts a new conversation.
    const allConversations: ConversationHeaderNode[] = [];
    let current: { anchor: ListItem; turns: ListItem[] } | null = null;
    for (const c of sorted) {
      const isAnchor = c.kind === "anchor" || c.kind === undefined;
      if (isAnchor) {
        if (current) allConversations.push(getOrCreateConversation(key, current.anchor, current.turns, 1));
        current = { anchor: c, turns: [] };
      } else {
        // continuation OR compressed → 都追加到当前对话。
        // continuation OR compressed → both append to the current conversation.
        if (!current) current = { anchor: c, turns: [] };
        else current.turns.push(c);
      }
    }
    if (current) allConversations.push(getOrCreateConversation(key, current.anchor, current.turns, 1));

    // 5. 把带 parentId 的子代理对话从顶层挪到 nestedByParent。
    // 5. Move subagent conversations whose anchor has parentId out of top-level into nestedByParent.
    const nestedByParent = new Map<string, ConversationHeaderNode[]>();
    const topLevel: ConversationHeaderNode[] = [];
    for (const conv of allConversations) {
      const parentId = conv.anchorItem.parentId;
      if (parentId) {
        const arr = nestedByParent.get(parentId);
        if (arr) arr.push(conv);
        else nestedByParent.set(parentId, [conv]);
      } else {
        topLevel.push(conv);
      }
    }

    // 重建嵌套对话到正确深度（depth 3 = parent leaf depth 2 + 1）。
    // Rebuild nested conversations at the correct depth (depth 3 = parent leaf depth 2 + 1).
    const NESTED_DEPTH = 3;
    const fixedNestedByParent = new Map<string, ConversationHeaderNode[]>();
    for (const [parentId, arr] of nestedByParent) {
      const fixed = arr.map((conv) =>
        getOrCreateConversation(key, conv.anchorItem, conv.turns, NESTED_DEPTH)
      );
      fixedNestedByParent.set(parentId, fixed);
    }

    // 6. 顶层对话按 endTime 降序；nestedByParent 内每个键下按 startTime 升序（派发顺序）。
    // 6. Top-level conversations newest-first by endTime; each nestedByParent bucket oldest-first (dispatch order).
    topLevel.sort((a, b) => b.endTime - a.endTime);
    for (const arr of fixedNestedByParent.values()) {
      arr.sort((a, b) => a.startTime - b.startTime);
    }

    // 7. Utility 桶按 mtime 升序。
    // 7. Utility bucket oldest-first.
    const sortedUtility = [...utility].sort((a, b) => a.mtime - b.mtime);

    let newest = 0;
    for (const c of captures) if (c.mtime > newest) newest = c.mtime;

    sessions.push(
      getOrCreateSession(key, topLevel, fixedNestedByParent, sortedUtility, newest, captures.length)
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

    // 顶层对话（最新在前）。
    // Top-level conversations (newest-first).
    for (const conv of node.conversations) {
      out.push(conv);
      if (collapsedKeys.has(conv.key)) continue;
      emitTurns(out, conv, node.nestedByParent, collapsedKeys);
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

// emitTurns: 把一个对话的 turns 展开成 leaf 行；在 compressed turn 前插 divider；
// 在派生了子代理的 turn 后插嵌套子代理对话。
// emitTurns: expand a conversation's turns into leaf rows; insert a divider before
// compressed turns; insert nested subagent conversations after a turn that spawned them.
function emitTurns(
  out: TreeNode[],
  conv: ConversationHeaderNode,
  nestedByParent: Map<string, ConversationHeaderNode[]>,
  collapsedKeys: Set<string>
): void {
  const convDepth = conv.depth;
  const leafDepth = convDepth + 1;
  for (const turn of conv.turns) {
    // compressed turn 前插一条 divider（深度与 leaf 一致）。
    // Insert a divider before a compressed turn (same depth as the leaf).
    if (turn.kind === "compressed") {
      out.push(getOrCreateDivider(turn.name, leafDepth, "context compressed"));
    }
    out.push(getOrCreateLeaf(turn, leafDepth));

    // 该 turn 派生了子代理？插嵌套对话（默认折叠）。
    // Did this turn spawn subagents? Insert nested conversations (collapsed by default).
    const nested = nestedByParent.get(turn.name);
    if (nested) {
      for (const subConv of nested) {
        out.push(subConv);
        if (collapsedKeys.has(subConv.key)) continue;
        // 嵌套对话的 turns 深度 +1。
        // Nested conversation's turns are one depth deeper.
        emitTurns(out, subConv, nestedByParent, collapsedKeys);
      }
    }
  }
}
