# Error shapes — when the framework's default isn't your API's contract

pathfinder's engine has one error model, and it does not change per app:
uncaught errors map to the `500` outcome, and
`throw new HttpError(status, body)` renders **the body verbatim** with that
status — coerced by the same rules as the handler return contract (object/array
→ JSON, string → text/plain, `Response` → itself, absent → empty). No envelope
is imposed; most real APIs get their exact error body from the throw
(`{"errcode", "error"}` for Matrix, `{"errors"}` for GraphQL-adjacent APIs), and
client faults need never render as 500s. This page is the toolbox, plus the
corners where the framework's defaults stop and your contract starts.

## `HttpError`: the body is the payload

```ts
import { HttpError } from "@pathfinder/pathfinder";

// Matrix-shaped errors, full throw ergonomics:
throw new HttpError(400, { errcode: "M_NOT_JSON", error: "Content not JSON." });

// FastAPI/globnotes-style envelope, written explicitly when you want it:
throw new HttpError(404, { detail: "Not Found" });

// Plain string → text/plain. Absent body → empty. Headers ride along:
throw new HttpError(401, "invalid token", { "www-authenticate": "Bearer" });
```

The second argument is the response **body, verbatim** — the same coercion the
handler return contract uses, with the error's status and headers applied on top
(explicit error headers win over body-implied ones). A `Response` body ships
as-is with the error's status. Post-fns always run after the throw — a root CORS
middleware still stamps the response, `accessLog()` still records the
disposition.

## Parse errors: `ParseError` + `parseJson`

A malformed request body is a client fault, but the framework's default maps any
uncaught error to `500` — the framework does not know that a `SyntaxError` from
`JSON.parse` means "bad client input". The shipped convenience makes the mapping
a one-line catch, and the verbatim-`HttpError` throw finishes it:

```ts
import { ParseError, parseJson } from "@pathfinder/pathfinder/body";
import { HttpError } from "@pathfinder/pathfinder";

export default async (request) => {
  try {
    // `await` matters: a bare `return parseJson(request)` would skip
    // the catch — the promise rejection never enters the try block.
    return await parseJson(request);
  } catch (error) {
    if (error instanceof ParseError) {
      throw new HttpError(400, {
        errcode: "M_NOT_JSON",
        error: "Content not JSON.",
      });
    }
    throw error;
  }
};
```

`parseJson(request)` wraps only `SyntaxError`; body-guard and limit errors pass
through untouched. Repeated per endpoint? Put it in a helper, or mount a
`disableStreaming` middleware in that subtree that maps the throw for its
routes.

## Return, don't throw, for computed responses

`HttpError` covers the error paths. For ordinary responses whose body is the
contract, return the response — the return contract is the contract:

```ts
import { json } from "@pathfinder/pathfinder/response";

export default () =>
  json({ errcode: "M_UNKNOWN", error: "Not found." }, {
    status: 404,
  });
```

Handlers may return a `Response` at any time; coercion never interprets intent.

## Framework-generated outcomes: `<digits>.ts` files

Outcomes the framework itself generates — `404` no-match, `405` method-miss,
`204` OPTIONS reflection, `500` handler-threw, `413` body-limit — render through
status-page files, resolved by nearest-ancestor cascade. Drop a `<digits>.ts`
file beside your routes to own the body:

```
endpoints/
  404.ts                 ← shapes every 404 in the tree below
  api/
    500.ts               ← shapes 500s for the api subtree
    send/post.ts
```

```ts
// endpoints/404.ts
import { json } from "@pathfinder/pathfinder/response";

export default (request, context) =>
  json({
    errcode: "M_UNRECOGNIZED",
    error: "Unrecognized request",
  }, { status: 404 });
```

Inside a `500.ts`, `context.error` holds the thrown value; inside
`404.ts`/`405.ts`, `context.miss` holds the match data. A renderer may return
any status it wants (stealth 404-masking is legal); the digits select the
outcome, not the response status. The package's own default outcome pages
(including their `{"detail": …}` bodies) are exactly such files — override them
per subtree whenever you want.
