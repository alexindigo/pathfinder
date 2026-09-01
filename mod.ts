// SPDX-License-Identifier: LGPL-3.0-only

/**
 * pathfinder — lean, mean, pathfinding state machine.
 *
 * A lean HTTP framework for Deno. Routes are the filesystem:
 * the `#` pattern grammar is filesystem-native, directory path = pattern,
 * `<method>.ts` file = handler.
 */

// Grammar + compiled automaton
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
  type LeafHandler,
  type LookupAnchor,
  type LookupResult,
  type Matcher,
  type Params,
  type ParamValue,
  type Route,
} from "./src/matcher.ts";

// HTTP contract
export {
  allowedMethods,
  coerceResult,
  ContractViolation,
  html,
  HttpError,
  json,
  redirect,
  text,
} from "./src/http.ts";

// Framework layer
export type {
  App,
  Context,
  Handler,
  Meta,
  Middleware,
  Miss,
  PathfinderBody,
  PathfinderRequest,
  PostFn,
  RemoteAddress,
  ResponseView,
  State,
} from "./src/router.ts";
