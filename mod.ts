// SPDX-License-Identifier: LGPL-3.0-only

/**
 * pathfinder — lean, mean, pathfinding state machine.
 *
 * A lean HTTP framework for Deno. Routes are the filesystem:
 * the `#` pattern grammar is filesystem-native, directory path = pattern,
 * `<method>.ts` file = handler.
 *
 * This root module is the framework face. Namespaced subpaths:
 * `./response` (response factories + ResponseView), `./middleware`
 * (the shipped optional set), `./body` (parse convenience + limits),
 * `./grammar` (pattern grammar + matcher), `./loader` (loader + generators).
 */

// Factory + loader
export { envRoots, pathfinder } from "./src/pathfinder.ts";
export type {
  ManifestRow,
  PathfinderApp,
  PathfinderOptions,
} from "./src/pathfinder.ts";

// Engine types (the handler & middleware face)
export type {
  App,
  Context,
  Handler,
  Meta,
  Middleware,
  Miss,
  PathfinderRequest,
  PostFn,
  RemoteAddress,
  State,
  WebSocketUpgrade,
} from "./src/router.ts";

// Error contract
export { HttpError } from "./src/http.ts";

// Param types (root: the params face of the matcher)
export type {
  DispatchDict,
  FactPayload,
  Params,
  ParamValue,
} from "./src/grammar/matcher.ts";
