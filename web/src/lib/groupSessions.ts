import type { ListItem } from "../types";

// 严格 3 层树：session → context（main/subagent，同级）→ request 叶子。
// 子代理 context 紧跟在派生它的主代理 context 后面（按 parentId 排序，而非结构嵌套）。
// 每个 context 下的叶子是 HTTP 请求（POST /messages），不是工具调用。
// Strict 3-level tree: session → context (main/subagent, siblings) → request leaves.
// Subagent contexts are ordered right after the main context that spawned them (by parentId,
// not structural nesting). Each context's leaves are HTTP requests (POST /messages), not tool calls.

export interface SessionNode {
  type: "session";
  depth: number;            // 0
  key: string;              // session key (directory prefix)
  name: string;             // session dirname
  conversations: ConversationHeaderNode[]; // ordered: main contexts with their subagents right after
  utilityBucket: ListItem[];               // utility-tagged captures, oldest-first
  utilityKey: string;       // `${key}#utility`
  startTime: number;        // earliest capture mtime — shown on the session header
  newestMtime: number;      // for cross-session sort
  captureCount: number;     // total, for the header badge
}

export interface ConversationHeaderNode {
  type: "conversation";
  depth: number;            // 1 — always; subagents are siblings, not nested
  key: string;              // `${sessionKey}#${anchorCaptureName}`
  anchorItem: ListItem;     // the anchor capture (first request); header label derived from it
  turns: ListItem[];        // continuation captures (requests 2..N), oldest-first
  turnCount: number;        // turns.length + 1 (anchor is request #1)
  startTime: number;        // anchorItem.mtime
  endTime: number;          // last turn mtime, or anchor mtime if no turns
  tag?: string;             // inherited from anchorItem.tag
  isBranch: boolean;        // true = subagent/explore context spawned by a main turn
}

export interface UtilityBucketNode {
  type: "utility";
  depth: number;            // 1
  key: string;              // `${sessionKey}#utility`
  captures: ListItem[];     // oldest-first
}

export interface LeafNode {
  type: "leaf";
  depth: number;            // 2 (a request under its context)
  key: string;              // capture filename (stable across polls)
  name: string;
  item: ListItem;
  label: string;            // "#1", "#2", ... — request number within the context
}

export interface DividerNode {
  type: "divider";
  depth: number;            // 2 — matches the request-leaf depth
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

function itemsEqualConvs(a: ConversationHeaderNode[], b: ConversationHeaderNode[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// 叶子缓存键包含 label（#N），因为同一 capture 在不同 context 里的编号不同。
// Leaf cache key includes the label (#N) since the same capture could appear with different
// numbers in different contexts (shouldn't happen in practice, but safe).
function getOrCreateLeaf(item: ListItem, depth: number, label: string): LeafNode {
  const cacheKey = `${item.name}#${label}`;
  let leaf = leafCache.get(cacheKey);
  if (!leaf || leaf.item !== item || leaf.depth !== depth) {
    leaf = { type: "leaf", depth, key: cacheKey, name: item.name, item, label };
    leafCache.set(cacheKey, leaf);
  }
  return leaf;
}

function getOrCreateConversation(
  sessionKey: string,
  anchor: ListItem,
  turns: ListItem[],
  isBranch: boolean
): ConversationHeaderNode {
  const key = `${sessionKey}#${anchor.name}`;
  const cached = conversationCache.get(key);
  if (
    cached &&
    cached.anchorItem === anchor &&
    itemsEqual(cached.turns, turns) &&
    cached.isBranch === isBranch
  ) {
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
    isBranch,
  };
  conversationCache.set(key, conv);
  return conv;
}

function getOrCreateUtility(key: string, captures: ListItem[]): UtilityBucketNode {
  const cached = utilityCache.get(key);
  if (cached && itemsEqual(cached.captures, captures)) return cached;
  const bucket: UtilityBucketNode = { type: "utility", depth: 1, key, captures };
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
  utilityBucket: ListItem[],
  startTime: number,
  newestMtime: number,
  captureCount: number
): SessionNode {
  const cached = sessionCache.get(key);
  if (
    cached &&
    itemsEqualConvs(cached.conversations, conversations) &&
    itemsEqual(cached.utilityBucket, utilityBucket) &&
    cached.startTime === startTime &&
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
    startTime,
    newestMtime,
    captureCount,
  };
  sessionCache.set(key, session);
  return session;
}

// 把扁平的 ListItem[] 组织成 3 层树：session → context → requests。
// 子代理 context 紧跟派生它的主代理 context（按 parentId 查找父 context）。
// Organize a flat ListItem[] into a 3-level tree: session → context → requests.
// Subagent contexts are ordered right after the main context that spawned them (found via parentId).
export function buildTree(items: ListItem[]): TreeNode[] {
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
    const conversational = captures.filter((c) => c.tag !== "utility");
    const utility = captures.filter((c) => c.tag === "utility");
    const sorted = [...conversational].sort((a, b) => a.mtime - b.mtime);

    // 1. anchor/continuation/compressed 分组（原逻辑）。
    // 1. anchor/continuation/compressed grouping (original logic).
    const allConversations: ConversationHeaderNode[] = [];
    let current: { anchor: ListItem; turns: ListItem[] } | null = null;
    for (const c of sorted) {
      const isAnchor = c.kind === "anchor" || c.kind === undefined;
      if (isAnchor) {
        if (current) allConversations.push(getOrCreateConversation(key, current.anchor, current.turns, false));
        current = { anchor: c, turns: [] };
      } else {
        if (!current) current = { anchor: c, turns: [] };
        else current.turns.push(c);
      }
    }
    if (current) allConversations.push(getOrCreateConversation(key, current.anchor, current.turns, false));

    // 2. 把带 parentId 的 context 标记为 branch，并按父 context 排序。
    //    子代理 context 出现在派生它的主代理 context 之后（同层兄弟，不嵌套）。
    // 2. Mark parentId contexts as branches; order them after their parent.
    //    Subagent contexts appear right after the main context that spawned them (siblings, not nested).
    const mainContexts = allConversations.filter((c) => !c.anchorItem.parentId);
    const subContexts = allConversations.filter((c) => c.anchorItem.parentId);

    // 给 sub 找到父 main context（ parentId 指向的 capture 属于哪个 main context）。
    // Find each sub's parent main context (which main context contains the parentId capture).
    function findParent(sub: ConversationHeaderNode): ConversationHeaderNode | null {
      const pid = sub.anchorItem.parentId;
      if (!pid) return null;
      for (const m of mainContexts) {
        if (m.anchorItem.name === pid || m.turns.some((t) => t.name === pid)) return m;
      }
      return null;
    }
    const subsByParent = new Map<ConversationHeaderNode, ConversationHeaderNode[]>();
    for (const sub of subContexts) {
      // 重建为 branch=true。
      // Rebuild as branch=true.
      const branchConv = getOrCreateConversation(key, sub.anchorItem, sub.turns, true);
      const parent = findParent(sub);
      if (parent) {
        const arr = subsByParent.get(parent);
        if (arr) arr.push(branchConv);
        else subsByParent.set(parent, [branchConv]);
      } else {
        // 没找到父 context —— 当作顶层 main 处理。
        // No parent found — treat as a top-level main.
        mainContexts.push(branchConv);
      }
    }

    // 3. 排序：main 按 endTime 降序；每个 main 下的 sub 按 startTime 升序（派发顺序）。
    // 3. Sort: mains by endTime desc; each main's subs by startTime asc (dispatch order).
    mainContexts.sort((a, b) => b.endTime - a.endTime);
    for (const arr of subsByParent.values()) {
      arr.sort((a, b) => a.startTime - b.startTime);
    }

    // 4. 交织：main1, sub1a, sub1b, main2, sub2a, ...
    // 4. Interleave: main1, sub1a, sub1b, main2, sub2a, ...
    const ordered: ConversationHeaderNode[] = [];
    for (const m of mainContexts) {
      ordered.push(m);
      const subs = subsByParent.get(m);
      if (subs) for (const s of subs) ordered.push(s);
    }

    // 5. utility 桶 + session 时间范围。
    // 5. Utility bucket + session time range.
    const sortedUtility = [...utility].sort((a, b) => a.mtime - b.mtime);
    let startTime = Infinity;
    let newest = 0;
    for (const c of captures) {
      if (c.mtime < startTime) startTime = c.mtime;
      if (c.mtime > newest) newest = c.mtime;
    }

    sessions.push(
      getOrCreateSession(key, ordered, sortedUtility, startTime === Infinity ? 0 : startTime, newest, captures.length)
    );
  }

  sessions.sort((a, b) => b.newestMtime - a.newestMtime);
  return sessions;
}

// 把树展平成可见行：session → context header → request leaves（含 anchor 作为 #1）。
// compressed 请求前插 divider。utility 桶同理。
// Flatten into visible rows: session → context header → request leaves (anchor is #1).
// A divider is emitted before compressed requests. Utility bucket works the same way.
export function flattenVisible(tree: TreeNode[], collapsedKeys: Set<string>): TreeNode[] {
  const out: TreeNode[] = [];
  for (const node of tree) {
    out.push(node);
    if (node.type !== "session") continue;
    if (collapsedKeys.has(node.key)) continue;

    for (const conv of node.conversations) {
      out.push(conv);
      if (collapsedKeys.has(conv.key)) continue;

      // anchor 是请求 #1。
      // The anchor is request #1.
      out.push(getOrCreateLeaf(conv.anchorItem, 2, "#1"));

      // 后续 turns 是 #2, #3, ...；compressed 前插 divider。
      // Subsequent turns are #2, #3, ...; emit a divider before compressed ones.
      for (let i = 0; i < conv.turns.length; i++) {
        const turn = conv.turns[i];
        if (turn.kind === "compressed") {
          out.push(getOrCreateDivider(turn.name, 2, "context compressed"));
        }
        out.push(getOrCreateLeaf(turn, 2, `#${i + 2}`));
      }
    }

    if (node.utilityBucket.length > 0) {
      out.push(getOrCreateUtility(node.utilityKey, node.utilityBucket));
      if (!collapsedKeys.has(node.utilityKey)) {
        for (let i = 0; i < node.utilityBucket.length; i++) {
          out.push(getOrCreateLeaf(node.utilityBucket[i], 2, `#${i + 1}`));
        }
      }
    }
  }
  return out;
}
