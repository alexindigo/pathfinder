// SPDX-License-Identifier: LGPL-3.0-only

import {
  parsePattern,
  routeShapeKey,
  typeRegistry,
  type TypeSpec,
} from "./grammar.ts";

// Compiled chunk automaton: all routes are parsed into chunks and inserted
// into a radix automaton walked over the raw request path. Dispatch is
// O(path length), independent of route count. Static edges carry byte-string
// labels (radix-compressed, may span `/`); bounded-dynamic edges carry their
// next-anchor text and a type validator compiled once at build; one crossing
// edge per node. Edge priority per node: static > bound-ref > typed bounded >
// untyped bounded > crossing. A small explicit stack backtracks over grammar
// choices (edge selection, crossing take-length) — never over characters
// within a committed capture.

export type ParamValue = string | number | bigint;

export type Params = Record<string, ParamValue>;

/** The matcher-level leaf handler (params in, value out). Framework-level
 * handlers have the (request, context) face — see router.ts. */
export type LeafHandler = (params: Params) => unknown;

export interface Route {
  method: string;
  pattern: string;
  handler: LeafHandler;
  /** Opaque payload returned by lookup() on a match (framework route entry). */
  data?: unknown;
  /** Directory tag recorded on the route's leaf node — the miss anchor's
   * directory for framework miss handling. Absent = untagged. */
  dir?: string;
}

export interface Matcher {
  handle(method: string, url: string): unknown;
}

/** Anchor of a miss: the deepest tagged point the walk reached, with the
 * captures along the anchor path and the unmatched remainder. */
export interface LookupAnchor {
  dir: string | null;
  params: Params;
  rest: string;
}

export type LookupResult =
  | { kind: "match"; params: Params; handler: LeafHandler; data: unknown }
  | { kind: "method-miss"; allowed: string[]; params: Params; data: unknown }
  | { kind: "no-match"; anchor: LookupAnchor | null };

interface BoundedEdge {
  name: string;
  type: string;
  /** Static text that must follow the capture; null = last chunk of its route. */
  anchor: string | null;
  /** Type validator from the registry, compiled at build. Null = no check. */
  validate: ((value: string) => boolean) | null;
  child: Node;
}

interface CrossingEdge {
  name: string;
  child: Node;
}

interface BoundRefEdge {
  name: string;
  child: Node;
}

interface Node {
  statics: Map<string, Node>;
  /** Static edges indexed by first byte — the radix invariant guarantees at
   * most one edge per first byte, so the walk does a single lookup + one
   * startsWith per node, independent of route count. */
  byFirst: Map<string, [string, Node][]>;
  boundRefs: BoundRefEdge[];
  bounded: BoundedEdge[];
  crossing: CrossingEdge | null;
  handlers: Map<string, LeafHandler> | null;
  /** Opaque per-method payloads parallel to handlers (framework route data). */
  data: Map<string, unknown> | null;
  /** Directory tag (route.dir of the last route inserted here). */
  dir: string | null;
}

function newNode(): Node {
  return {
    statics: new Map(),
    byFirst: new Map(),
    boundRefs: [],
    bounded: [],
    crossing: null,
    handlers: null,
    data: null,
    dir: null,
  };
}

function setStaticEdge(node: Node, label: string, child: Node): void {
  node.statics.set(label, child);
  const bucket = node.byFirst.get(label[0]);
  if (bucket !== undefined) {
    const existing = bucket.find((e) => e[0] === label);
    if (existing !== undefined) existing[1] = child;
    else bucket.push([label, child]);
  } else {
    node.byFirst.set(label[0], [[label, child]]);
  }
}

function deleteStaticEdge(node: Node, label: string): void {
  node.statics.delete(label);
  const bucket = node.byFirst.get(label[0]);
  if (bucket !== undefined) {
    const i = bucket.findIndex((e) => e[0] === label);
    if (i !== -1) {
      bucket.splice(i, 1);
      if (bucket.length === 0) node.byFirst.delete(label[0]);
    }
  }
}

function longestCommonPrefix(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

function addBounded(node: Node, edge: BoundedEdge): void {
  if (edge.type !== "string") {
    let i = 0;
    while (i < node.bounded.length && node.bounded[i].type !== "string") i++;
    node.bounded.splice(i, 0, edge);
  } else {
    node.bounded.push(edge);
  }
}

/** Radix insertion: longest-common-prefix splitting for static labels. */
function insertStatic(node: Node, text: string): Node {
  for (const [label, child] of node.statics) {
    const lcp = longestCommonPrefix(label, text);
    if (lcp === 0) continue;
    if (lcp === label.length) {
      if (lcp === text.length) return child;
      return insertStatic(child, text.slice(lcp));
    }
    if (lcp === text.length) {
      deleteStaticEdge(node, label);
      const mid = newNode();
      setStaticEdge(mid, label.slice(lcp), child);
      setStaticEdge(node, text, mid);
      return mid;
    }
    deleteStaticEdge(node, label);
    const mid = newNode();
    setStaticEdge(mid, label.slice(lcp), child);
    setStaticEdge(node, label.slice(0, lcp), mid);
    return insertStatic(mid, text.slice(lcp));
  }
  const fresh = newNode();
  setStaticEdge(node, text, fresh);
  return fresh;
}

export class CompiledMatcher implements Matcher {
  private root: Node;
  private seen = new Map<string, string>();
  /** Effective type registry: built-ins + per-instance custom types (immutable
   * after boot — the factory's `types` option). */
  private registry: Record<string, TypeSpec>;

  constructor(routes: Route[], opts?: { types?: Record<string, TypeSpec> }) {
    this.root = newNode();
    this.registry = opts?.types
      ? { ...typeRegistry, ...opts.types }
      : typeRegistry;
    for (const r of routes) this.add(r);
  }

  /** Incremental insertion; same duplicate detection as construction. */
  add(route: Route): void {
    const key = route.method + ":" +
      routeShapeKey(route.pattern, this.registry);
    const prev = this.seen.get(key);
    if (prev !== undefined) {
      throw new Error(`Duplicate route pattern: ${route.pattern} and ${prev}`);
    }
    this.seen.set(key, route.pattern);
    this.insert(route);
  }

  private insert(route: Route): void {
    let node = this.root;
    const chunks = parsePattern(route.pattern, this.registry);
    const bound = new Set<string>();
    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      if (chunk.kind === "static") {
        node = insertStatic(node, chunk.text);
      } else {
        if (bound.has(chunk.name)) {
          // Bound-ref (repeated name): equality constraint matched by literal
          // insertion at match time. A repeated crossing dynamic needs no
          // take-loop.
          let ref = node.boundRefs.find((b) => b.name === chunk.name);
          if (!ref) {
            ref = { name: chunk.name, child: newNode() };
            node.boundRefs.push(ref);
          }
          node = ref.child;
        } else if (chunk.crossing) {
          if (node.crossing === null) {
            node.crossing = { name: chunk.name, child: newNode() };
          }
          node = node.crossing.child;
        } else {
          const next = chunks[ci + 1];
          const anchor = next !== undefined && next.kind === "static"
            ? next.text
            : null;
          const validate = chunk.type === "string"
            ? null
            : this.registry[chunk.type].validate;
          let edge = node.bounded.find((b) =>
            b.name === chunk.name && b.type === chunk.type &&
            b.anchor === anchor
          );
          if (!edge) {
            edge = {
              name: chunk.name,
              type: chunk.type,
              anchor,
              validate,
              child: newNode(),
            };
            addBounded(node, edge);
          }
          node = edge.child;
        }
        bound.add(chunk.name);
      }
    }
    if (node.handlers === null) node.handlers = new Map();
    if (node.handlers.has(route.method)) {
      throw new Error(`Duplicate route: ${route.method} ${route.pattern}`);
    }
    node.handlers.set(route.method, route.handler);
    if (route.data !== undefined) {
      if (node.data === null) node.data = new Map();
      node.data.set(route.method, route.data);
    }
    if (route.dir !== undefined) node.dir = route.dir;
  }

  handle(method: string, url: string): unknown {
    const result = this.lookup(method, url);
    return result.kind === "match" ? result.handler(result.params) : null;
  }

  /**
   * Rich lookup: the same priority-ordered walk as handle(), returning a
   * discriminated result. The first structurally-accepting leaf reached
   * without the request method is recorded as a method-miss candidate (a
   * lower-priority route may still match); the deepest tagged frame reached
   * across the whole walk is the miss anchor, with the captures along the
   * anchor path and the unmatched remainder.
   */
  lookup(method: string, url: string): LookupResult {
    // Slashes are ordinary payload bytes inside a crossing capture — no
    // global `//` rejection, no pre-walk trailing-slash strip. Trailing-slash
    // tolerance lives at leaf acceptance (exactly one `/`). Outside crossing
    // spans, `//` rejects structurally (empty bounded window / no static
    // match).
    const path = this.extractPath(url);

    const captures: { name: string; type: string; value: string }[] = [];
    const toParams = (list: typeof captures): Params => {
      // Pipeline per capture: validate RAW (at capture time) → decode →
      // parse to the typed value.
      const params: Params = {};
      for (const c of list) {
        const decoded = decodeURIComponent(c.value);
        params[c.name] = c.type === "string"
          ? decoded
          : this.registry[c.type].parse(decoded);
      }
      return params;
    };

    type Capture = { name: string; type: string; value: string };
    type MissCandidate = {
      allowed: string[];
      data: unknown;
      captures: Capture[];
    };
    type AnchorCandidate = { dir: string; pos: number; captures: Capture[] };
    // Holder objects — TS narrowing can't see the closure assignments.
    const missRef: { value: MissCandidate | null } = { value: null };
    const anchorRef: { value: AnchorCandidate | null } = { value: null };

    const stack: {
      node: Node;
      pos: number;
      stage: "static" | "boundRefs" | "bounded" | "crossing";
      idx: number;
      cands: number[] | null;
      candsIdx: number;
      capBase: number;
    }[] = [];
    const pushFrame = (node: Node, pos: number, capBase = captures.length) => {
      if (
        node.dir !== null &&
        (anchorRef.value === null || anchorRef.value.pos < pos)
      ) {
        anchorRef.value = { dir: node.dir, pos, captures: captures.slice() };
      }
      stack.push({
        node,
        pos,
        stage: "static",
        idx: 0,
        cands: null,
        candsIdx: 0,
        capBase,
      });
    };
    const recordMiss = (node: Node) => {
      if (missRef.value !== null || node.handlers === null) return;
      missRef.value = {
        allowed: [...node.handlers.keys()],
        data: node.data === null ? undefined : node.data.values().next().value,
        captures: captures.slice(),
      };
    };
    pushFrame(this.root, 0);

    while (stack.length > 0) {
      const f = stack[stack.length - 1];

      if (f.stage === "static") {
        const atEnd = f.pos === path.length;
        const toleratedTrailingSlash = f.pos === path.length - 1 &&
          path[f.pos] === "/";
        if (atEnd || toleratedTrailingSlash) {
          const handler = f.node.handlers?.get(method);
          if (handler !== undefined) {
            return {
              kind: "match",
              params: toParams(captures),
              handler,
              data: f.node.data?.get(method),
            };
          }
          if (f.node.handlers !== null) recordMiss(f.node);
          if (atEnd) {
            captures.length = f.capBase;
            stack.pop();
            continue;
          }
          // Tolerated trailing slash but no handler here: fall through to
          // edge matching — a longer route may still consume the `/`.
        }
        let matched: [string, Node] | null = null;
        const bucket = f.node.byFirst.get(path[f.pos]);
        if (bucket !== undefined) {
          for (const [label, child] of bucket) {
            if (path.startsWith(label, f.pos)) {
              matched = [label, child];
              break;
            }
          }
        }
        f.stage = "boundRefs";
        if (matched !== null) pushFrame(matched[1], f.pos + matched[0].length);
        continue;
      }

      if (f.stage === "boundRefs") {
        let pushed = false;
        while (f.idx < f.node.boundRefs.length) {
          const ref = f.node.boundRefs[f.idx++];
          const bound = captures.find((c) => c.name === ref.name);
          if (bound !== undefined && path.startsWith(bound.value, f.pos)) {
            pushFrame(ref.child, f.pos + bound.value.length);
            pushed = true;
            break;
          }
        }
        if (!pushed) f.stage = "bounded";
        continue;
      }

      if (f.stage === "bounded") {
        let pushed = false;
        while (f.idx < f.node.bounded.length) {
          const edge = f.node.bounded[f.idx++];
          const slash = path.indexOf("/", f.pos);
          const windowEnd = slash === -1 ? path.length : slash;
          let captureEnd = -1;
          if (edge.anchor === null) {
            captureEnd = windowEnd;
          } else {
            // First position where the entire next anchor matches, within the
            // no-slash window (the anchor may begin at the slash); then
            // hard-commit — no retry at a later occurrence. An empty capture
            // (anchor at pos) fails.
            const idx = path.indexOf(edge.anchor, f.pos);
            if (idx !== -1 && idx <= windowEnd) captureEnd = idx;
          }
          if (captureEnd === -1 || captureEnd === f.pos) continue;
          const value = path.slice(f.pos, captureEnd);
          if (edge.validate !== null && !edge.validate(value)) continue;
          const capMark = captures.length;
          captures.push({ name: edge.name, type: edge.type, value });
          // The capture is undone when the child's subtree fails and pops.
          pushFrame(edge.child, captureEnd, capMark);
          pushed = true;
          break;
        }
        if (!pushed) f.stage = "crossing";
        continue;
      }

      // Crossing: anchor-guided candidate enumeration. Grammar guarantees the
      // child of a crossing edge holds only static edges and/or leaf handlers
      // (a dynamic directly after a rest is an empty-anchor build error), so
      // the only positions where a take can succeed are `path.length` (if the
      // child is a leaf) and the occurrences of the child's static labels.
      // The candidate set is exactly the subset of old per-character takes
      // whose child frame survives its first static hop; every excluded take
      // failed immediately in the old walk, and order among surviving takes
      // is unchanged (descending = greedy-longest). Therefore accept/reject
      // and captures are identical to the old take-loop.
      const cross = f.node.crossing;
      if (cross === null) {
        captures.length = f.capBase;
        stack.pop();
        continue;
      }
      if (f.cands === null) {
        const set = new Set<number>();
        if (cross.child.handlers !== null) set.add(path.length);
        for (const [label] of cross.child.statics) {
          let from = f.pos + 1; // capture must be non-empty
          for (;;) {
            const idx = path.indexOf(label, from);
            if (idx === -1) break;
            set.add(idx);
            from = idx + 1; // overlap-inclusive: every occurrence
          }
        }
        f.cands = [...set].sort((a, b) => b - a);
      }
      if (f.candsIdx < f.cands.length) {
        const q = f.cands[f.candsIdx++];
        const value = path.slice(f.pos, q);
        const capMark = captures.length;
        // Crossing rests are untyped (string) — no (type) annotation is
        // expressible on a rest.
        captures.push({ name: cross.name, type: "string", value });
        pushFrame(cross.child, q, capMark);
      } else {
        captures.length = f.capBase;
        stack.pop();
      }
    }
    if (missRef.value !== null) {
      return {
        kind: "method-miss",
        allowed: missRef.value.allowed,
        params: toParams(missRef.value.captures),
        data: missRef.value.data,
      };
    }
    const anchor = anchorRef.value;
    return {
      kind: "no-match",
      anchor: anchor === null ? null : {
        dir: anchor.dir,
        params: toParams(anchor.captures),
        rest: path.slice(anchor.pos),
      },
    };
  }

  /**
   * Fast path: if the URL contains no `?`, `#`, or dot segments, use it
   * as-is; otherwise fall back to URL parsing. Dot segments include the
   * trailing forms (`/.`, `/..`), which URL parsing normalizes away just
   * like `/./` and `/../`.
   */
  private extractPath(url: string): string {
    if (
      !url.includes("?") && !url.includes("#") &&
      !url.includes("/./") && !url.includes("/../") &&
      !url.endsWith("/.") && !url.endsWith("/..")
    ) {
      return url;
    }
    return new URL(url, "http://localhost").pathname;
  }
}
