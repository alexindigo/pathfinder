// SPDX-License-Identifier: LGPL-3.0-only

/**
 * pathfinder — lean, mean, pathfinding state machine.
 *
 * A lean HTTP framework for Deno. Routes are the filesystem:
 * the `#` pattern grammar is filesystem-native, directory path = pattern,
 * `<method>.ts` file = handler.
 */

export {
  type Chunk,
  type DynamicChunk,
  parsePattern,
  routeShapeKey,
  type StaticChunk,
  typeRegistry,
  type TypeSpec,
} from "./src/grammar.ts";

export {
  CompiledMatcher,
  type Handler,
  type Matcher,
  type Params,
  type ParamValue,
  type Route,
} from "./src/matcher.ts";
