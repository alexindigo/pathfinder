// SPDX-License-Identifier: LGPL-3.0-only

import type { Route } from "../../../src/matcher.ts";
import { sharedHandler } from "../handlers.ts";

const routes: Route[] = [
  // Long compound segments
  {
    method: "GET",
    pattern: "/x/#a-#b-#c-#d-#e-#f-#g-#h/get",
    handler: sharedHandler,
  },
  {
    method: "GET",
    pattern: "/y/#a-#b-#c-#d-#e-#f-#g-#h-#i-#j/get",
    handler: sharedHandler,
  },

  // Multi-rest patterns (D-5a)
  { method: "GET", pattern: "/#...a/mid/#...b/get", handler: sharedHandler },

  // Deeply typed params
  {
    method: "GET",
    pattern: "/api/#(int)a/#(int)b/#(int)c/#(int)d/get",
    handler: sharedHandler,
  },
  {
    method: "GET",
    pattern: "/api/#(int)a/#(int)b/#(int)c/get",
    handler: sharedHandler,
  },

  // Many overlapping patterns at same prefix
  {
    method: "GET",
    pattern: "/api/v1/rooms/#roomId/messages",
    handler: sharedHandler,
  },
  {
    method: "GET",
    pattern: "/api/v1/rooms/#roomId/state",
    handler: sharedHandler,
  },
  {
    method: "GET",
    pattern: "/api/v1/rooms/#roomId/members",
    handler: sharedHandler,
  },
  {
    method: "GET",
    pattern: "/api/v1/rooms/#roomId/join",
    handler: sharedHandler,
  },
  {
    method: "GET",
    pattern: "/api/v1/rooms/#roomId/leave",
    handler: sharedHandler,
  },
  {
    method: "GET",
    pattern: "/api/v1/rooms/#roomId/invite",
    handler: sharedHandler,
  },
  {
    method: "GET",
    pattern: "/api/v1/rooms/#roomId/kick",
    handler: sharedHandler,
  },
  {
    method: "GET",
    pattern: "/api/v1/rooms/#roomId/ban",
    handler: sharedHandler,
  },
  {
    method: "GET",
    pattern: "/api/v1/rooms/#roomId/unban",
    handler: sharedHandler,
  },
  {
    method: "GET",
    pattern: "/api/v1/rooms/#roomId/forget",
    handler: sharedHandler,
  },
  {
    method: "GET",
    pattern: "/api/v1/rooms/#roomId/upgrade",
    handler: sharedHandler,
  },
  {
    method: "GET",
    pattern: "/api/v1/rooms/#roomId/aliases",
    handler: sharedHandler,
  },
  {
    method: "GET",
    pattern: "/api/v1/rooms/#roomId/event/#eventId",
    handler: sharedHandler,
  },
  {
    method: "GET",
    pattern: "/api/v1/rooms/#roomId/context/#eventId",
    handler: sharedHandler,
  },
  {
    method: "GET",
    pattern: "/api/v1/rooms/#roomId/redact/#eventId",
    handler: sharedHandler,
  },
  {
    method: "GET",
    pattern: "/api/v1/rooms/#roomId/relations/#eventId",
    handler: sharedHandler,
  },
  {
    method: "GET",
    pattern: "/api/v1/rooms/#roomId/tags",
    handler: sharedHandler,
  },
  {
    method: "GET",
    pattern: "/api/v1/rooms/#roomId/account_data",
    handler: sharedHandler,
  },
  {
    method: "GET",
    pattern: "/api/v1/rooms/#roomId/report",
    handler: sharedHandler,
  },
  {
    method: "GET",
    pattern: "/api/v1/rooms/#roomId/threads",
    handler: sharedHandler,
  },
  {
    method: "GET",
    pattern: "/api/v1/rooms/#roomId/spaces",
    handler: sharedHandler,
  },
  {
    method: "GET",
    pattern: "/api/v1/rooms/#roomId/hierarchy",
    handler: sharedHandler,
  },
  {
    method: "GET",
    pattern: "/api/v1/rooms/#roomId/timestamp_to_event",
    handler: sharedHandler,
  },
  {
    method: "GET",
    pattern: "/api/v1/rooms/#roomId/aliases/#alias",
    handler: sharedHandler,
  },

  // Mixed typed + untyped
  {
    method: "GET",
    pattern: "/api/#(int)version/#name",
    handler: sharedHandler,
  },
  {
    method: "GET",
    pattern: "/api/#(int)version/#name/#...rest",
    handler: sharedHandler,
  },

  // Rest at various positions
  { method: "GET", pattern: "/static/#...path", handler: sharedHandler },
  {
    method: "GET",
    pattern: "/download/#category/#...path",
    handler: sharedHandler,
  },
  { method: "GET", pattern: "/proxy/#...path/get", handler: sharedHandler },

  // Compound with rest (D-5a)
  {
    method: "GET",
    pattern: "/archive/#year-#...slug/get",
    handler: sharedHandler,
  },

  // Deep nesting with literals
  {
    method: "GET",
    pattern: "/api/v2/users/#userId/posts/#postId/comments/#commentId",
    handler: sharedHandler,
  },
  {
    method: "GET",
    pattern: "/api/v2/users/#userId/posts/#postId/likes",
    handler: sharedHandler,
  },
  {
    method: "GET",
    pattern: "/api/v2/users/#userId/followers",
    handler: sharedHandler,
  },
  {
    method: "GET",
    pattern: "/api/v2/users/#userId/following",
    handler: sharedHandler,
  },
  {
    method: "GET",
    pattern: "/api/v2/users/#userId/settings",
    handler: sharedHandler,
  },
];

export default routes;
