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

// Factory + loader
export { envRoots, pathfinder } from "./src/pathfinder.ts";
export type {
  ManifestRow,
  PathfinderApp,
  PathfinderOptions,
} from "./src/pathfinder.ts";
export { walkRoot } from "./src/loader.ts";
export type {
  Entry,
  EntryModule,
  IndexRoot,
  LayerIndexEntry,
  ResolveOptions,
  Root,
} from "./src/loader.ts";

// Tree index generator (packaged trees)
export { generateIndex } from "./src/index-gen.ts";
export type { GenIndexOptions, GenIndexResult } from "./src/index-gen.ts";

// Body limits
export { BodyLimitError, GiB, KiB, MiB } from "./src/body_limit.ts";

// Generated route types
export { dirParams, generateTypes } from "./src/types-gen.ts";
export type { GenResult } from "./src/types-gen.ts";
