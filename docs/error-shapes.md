# Error shapes — when the framework's default isn't your API's contract

pathfinder's engine has one error model, and it does not change per app:
uncaught errors map to the `500` outcome, and
`throw new HttpError(status,
detail)` renders `{"detail": …}` with that status.
That is the right default — it is honest about what the framework knows. But
most real APIs have their own error body (`{"errcode", "error"}` for Matrix,
`{"errors"}` for GraphQL- adjacent APIs), and client faults must not render as
500s. This page is the toolbox for making the framework's outcomes speak your
contract, without changing the framework.

## Rule one: return, don't throw, when the body is the contract

A thrown `HttpError` always renders `{"detail": …}`. When your API needs a
shaped body, return the response yourself:

```ts
import { json } from "@pathfinder/pathfinder";

export default () =>
  json({ errcode: "M_UNKNOWN", error: "Not found." }, {
    status: 404,
  });
```

This is not a workaround — the return contract is the contract. Handlers may
return a `Response` at any time; coercion never interprets intent.

## Parse errors: `ParseError` + `parseJson`

A malformed request body is a client fault, but the framework's default maps any
uncaught error to `500` — the framework does not know that a `SyntaxError` from
`JSON.parse` means "bad client input". The shipped convenience makes the mapping
a one-line catch:

```ts
import { json, ParseError, parseJson } from "@pathfinder/pathfinder";

export default async (request) => {
  try {
    // `await` matters: a bare `return parseJson(request)` would skip
    // the catch — the promise rejection never enters the try block.
    return await parseJson(request);
  } catch (error) {
    if (error instanceof ParseError) {
      return json({ errcode: "M_NOT_JSON", error: "Content not JSON." }, {
        status: 400,
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
import { json } from "@pathfinder/pathfinder";

export default (request, context) =>
  json({
    errcode: "M_UNRECOGNIZED",
    error: "Unrecognized request",
  }, { status: 404 });
```

Inside a `500.ts`, `context.error` holds the thrown value; inside
`404.ts`/`405.ts`, `context.miss` holds the match data. A renderer may return
any status it wants (stealth 404-masking is legal); the digits select the
outcome, not the response status.

## `HttpError` for everything else

When the `{"detail": …}` shape is acceptable, `HttpError` stays the honest
ergonomic throw:

```ts
throw new HttpError(401, "invalid token", { "www-authenticate": "Bearer" });
```

Renders `{"detail": "invalid token"}` with status 401 and your headers. Post-fns
always run after it — a root CORS middleware still stamps the response,
`accessLog()` still records the disposition.
