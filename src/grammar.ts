// SPDX-License-Identifier: LGPL-3.0-only

// Grammar v2: pattern → chunk list + build-time validation.
//
// A route pattern is a sequence of chunks: static anchors and dynamic
// captures. `/` is never structural — it appears inside static text and is
// the one character a bounded dynamic refuses to contain.
//
//   name    := [$_A-Za-z][$_A-Za-z0-9]*        (ASCII; legal JS identifier)
//   dynamic := "#" [ "(" type ")" ] ["..."] name [ "#" ]
//   type    := registry lookup
//
// A dynamic's name ends at the first non-identifier character or at an
// explicit `#` stop signal (consumed, belongs to no chunk). The stop is only
// needed when the following anchor starts with an identifier char or `(`.
// A `(` directly after a dynamic's name is reserved for future parameterized
// syntax and is a build-time error; a literal paren anchor after a param is
// written with the stop signal (`#a#(v2)`).

export interface StaticChunk {
  kind: "static";
  text: string;
}

export interface DynamicChunk {
  kind: "dynamic";
  name: string;
  type: string;
  /** `...` was present in the source pattern. */
  rest: boolean;
  /**
   * Rest classification: a `#...name` is crossing iff it occupies a full
   * inter-slash span (adjacent anchors end with `/` on the left and start
   * with `/` on the right, or pattern boundary). Otherwise it is a bounded
   * dynamic. Non-rest dynamics are never crossing.
   */
  crossing: boolean;
}

export type Chunk = StaticChunk | DynamicChunk;

/**
 * Type registry v2. Pipeline per capture: validate the RAW capture
 * (pre-decode; D6), then decode, then parse to the typed value.
 */
export interface TypeSpec {
  /** Runs on the raw (pre-decode) capture. */
  validate(value: string): boolean;
  /** Runs on the decoded capture; produces the coerced param value. */
  parse(value: string): string | number | bigint;
}

export const typeRegistry: Record<string, TypeSpec> = {
  string: {
    validate: () => true,
    parse: (value) => value,
  },
  num: {
    // Plain decimal literal (user ruling 2026-08-31): no exponent, no hex,
    // no Infinity/NaN. Double semantics via Number().
    validate: (value) => /^-?\d+(\.\d+)?$/.test(value),
    parse: (value) => Number(value),
  },
  int: {
    // Arbitrary precision — big ids (snowflake etc.) never truncate.
    // bigint is not JSON-serializable; converting for output is the
    // handler's job.
    validate: (value) => /^-?\d+$/.test(value),
    parse: (value) => BigInt(value),
  },
};

const NAME_RE = /^[$_A-Za-z][$_A-Za-z0-9]*$/;
const IDENT_CHAR = /[$_A-Za-z0-9]/;

export function parsePattern(pattern: string): Chunk[] {
  const chunks: Chunk[] = [];
  const boundTypes = new Map<string, string>();
  let staticBuf = "";
  let i = 0;

  const flushStatic = () => {
    if (staticBuf !== "") {
      chunks.push({ kind: "static", text: staticBuf });
      staticBuf = "";
    }
  };

  while (i < pattern.length) {
    if (pattern[i] !== "#") {
      staticBuf += pattern[i];
      i++;
      continue;
    }
    flushStatic();
    i++;
    let type = "string";
    let explicitType = false;
    if (pattern[i] === "(") {
      const close = pattern.indexOf(")", i + 1);
      if (close === -1) {
        throw new Error(`Unclosed "(" type annotation in pattern "${pattern}"`);
      }
      type = pattern.slice(i + 1, close);
      if (!(type in typeRegistry)) {
        throw new Error(`Unknown type "${type}" in pattern "${pattern}"`);
      }
      explicitType = true;
      i = close + 1;
    }
    let rest = false;
    if (pattern.startsWith("...", i)) {
      rest = true;
      i += 3;
    }
    if (rest && explicitType) {
      throw new Error(
        `(type) annotation on a rest dynamic is not supported in pattern "${pattern}"`,
      );
    }
    if (chunks.length > 0 && chunks[chunks.length - 1].kind === "dynamic") {
      throw new Error(
        `Empty anchor between two dynamics in pattern "${pattern}"`,
      );
    }
    const nameStart = i;
    while (i < pattern.length && IDENT_CHAR.test(pattern[i])) i++;
    const name = pattern.slice(nameStart, i);
    if (!NAME_RE.test(name)) {
      throw new Error(
        `Invalid parameter name "${name}" in pattern "${pattern}"`,
      );
    }
    if (pattern[i] === "(") {
      throw new Error(
        `"(" directly after a parameter name is reserved for future parameterized syntax in pattern "${pattern}"`,
      );
    }
    const prevType = boundTypes.get(name);
    if (prevType === undefined) {
      boundTypes.set(name, type);
    } else if (prevType !== type) {
      throw new Error(
        `Conflicting type re-annotation for "${name}" (${prevType} vs ${type}) in pattern "${pattern}"`,
      );
    }
    if (pattern[i] === "#") i++; // stop signal, consumed, belongs to no chunk
    chunks.push({ kind: "dynamic", name, type, rest, crossing: false });
  }
  flushStatic();

  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c];
    if (chunk.kind !== "dynamic" || !chunk.rest) continue;
    const left = c > 0 ? chunks[c - 1] : null;
    const right = c < chunks.length - 1 ? chunks[c + 1] : null;
    const leftOk = left === null ||
      (left.kind === "static" && left.text.endsWith("/"));
    const rightOk = right === null ||
      (right.kind === "static" && right.text.startsWith("/"));
    if (leftOk && rightOk) chunk.crossing = true;
  }

  return chunks;
}

/**
 * Normalized shape of a pattern for duplicate-route detection: static
 * anchors keep their text, dynamics collapse to kind markers. The caller
 * prepends the HTTP method. Injective because static text never contains
 * `#` and every marker starts with `#`.
 */
export function routeShapeKey(pattern: string): string {
  return parsePattern(pattern).map((c) =>
    c.kind === "static"
      ? c.text
      : c.rest
      ? "#..."
      : c.type === "string"
      ? "#"
      : `#(${c.type})`
  ).join("");
}
