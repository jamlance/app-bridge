# @inkress/app-bridge

Client SDK for [Inkress](https://inkress.com) embedded apps — runs
inside your iframe, gives you merchant identity, host-rendered UI
primitives, browser-back-button sync, and a one-call exchange to a
regular `inka_` access token.

## Install

```bash
npm install @inkress/app-bridge
```

## Quickstart

```ts
import { createInkressApp } from "@inkress/app-bridge";

const inkress = await createInkressApp();

console.log(`Hello, ${inkress.merchant.name}`);

inkress.notify({ kind: "success", message: "Order created" });

const confirmed = await inkress.confirm({
  title: "Refund this order?",
  body: "This refunds $100 USD. Cannot be undone.",
  destructive: true,
});

inkress.navigate.embed("/orders/123");

// Exchange the session JWT for a normal API access token (RFC 8693).
// Use your backend for this — the example shows the shape only.
const at = await inkress.session.exchange({
  clientId: "inkid_…",
  clientSecret: "…",
});
```

## What it does

When the merchant opens your app from the Inkress dashboard, the host
loads your iframe with `?inkress_session=<jwt>` in the URL.
`createInkressApp()`:

1. Reads the token from the URL and `history.replaceState`s it out
   so it doesn't survive in the browser history.
2. Decodes the JWT to learn the host origin from the `iss` claim.
3. postMessages `inkress.ready` to the host.
4. Awaits `inkress.config` (10s timeout) — the bootstrap payload with
   merchant identity, scopes, locale, theme, and the current session.
5. Wires up a strict origin-checked message receiver.
6. Schedules proactive session refresh so you never see an expired
   token.

After bootstrap, the returned `InkressApp` object exposes:

| Surface | Methods |
|---|---|
| Identity | `merchant`, `user`, `scopes`, `locale`, `theme`, `hostOrigin` |
| UI primitives | `notify`, `confirm`, `modal.open` / `modal.close`, `clipboard.write`, `resize` |
| Navigation | `navigate.embed(path)`, `navigate.host(path)` |
| Session | `session.current()`, `session.onRefresh(cb)`, `session.refresh()`, `session.exchange({ clientId, clientSecret })` |
| Host events | `events.on('route.changed' \| 'theme.changed', cb)` |
| Lifecycle | `destroy()` |

See the
[Inkress embedded apps spec](https://docs.inkress.com/embedded) for the
full protocol and surface model.

## Authenticating API calls

```ts
const at = await inkress.session.exchange({
  clientId: "inkid_…",
  clientSecret: "…",
});

await fetch("https://api.inkress.com/api/v1/orders", {
  headers: { Authorization: `Bearer ${at.access_token}` },
});
```

Embedded sessions are **online-only** by default — no refresh token is
issued unless your original consent included `offline_access` and you
re-request it via the `scope` argument.

## CSP requirement

Your embed routes must allow Inkress as a frame ancestor:

```
Content-Security-Policy: frame-ancestors https://merchant.inkress.com https://*.commerce.webapps.host;
```

Without this, the browser will refuse to render your page inside the
dashboard. Inkress's iframe loader detects the refusal via a 5s
`inkress.ready` timeout and shows an actionable "this app refused to
load" error.

## Verifying the session token (backend)

The session JWT is signed with your app's `whsec_` (the same secret
Inkress uses to sign your webhook deliveries). You can verify it on
your backend:

```ts
import { verifyJwtWithSecret } from "@inkress/app-bridge";

const claims = await verifyJwtWithSecret(jwt, process.env.WHSEC!);
// { merchant_id, user_id, scopes, session_id, … }
```

**Never ship `whsec_` to the browser.** The browser-side bridge relies
on strict origin checks plus the JWT's structural validity to
authenticate inbound messages; full HMAC verification belongs on your
server.

## Origin verification

`createInkressApp` derives the expected host origin from the JWT's
`iss` claim and rejects every inbound `postMessage` whose origin
doesn't match. Outbound calls use that exact origin as `targetOrigin`
— never `'*'`. If you want to override (e.g., for a private staging
environment), pass `hostOriginOverride`.

## License

MIT.
