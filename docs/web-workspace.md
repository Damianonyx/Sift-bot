# Shared Telegram and web workspace

`src/web-server.js` exposes an optional same-origin HTTP interface alongside
the existing bot process. It reuses `createResponder`, stores, authorization
and the existing background runners. There is still one poller and one database.
It is disabled by default and adds no dependency or paid API.

The client lives in `Damianonyx/SiftAgent`, under `dist/app`, on branch
`codex/web-workspace`. Its `WEB_APP.md` contains setup and browser checks.

Enable with `SIFT_WEB_ENABLED=true`, `SIFT_WEB_ROOT` pointing to that app folder,
`SIFT_WEB_PORT=3000`, and `SIFT_WEB_ORIGIN` set to the exact browser origin. Only
localhost may use HTTP; other origins require HTTPS. Bind to `0.0.0.0` only when
needed for a forwarded port or reverse proxy. Keep the app and API on one origin.

In a Codespace, its forwarded HTTPS port URL is the origin, not the IDE URL.
[Open the existing Codespace](https://effective-carnival-wr5j9v5g9775c95q9.github.dev/).
Private port access remains gated by GitHub as well as Sift. No hosting migration
is included and the runtime must stay running for both interfaces to work.

## Authentication and mutations

- `/web` or the `start=web` deep link issues a single-use five-minute link only
  to an allowlisted user in their own private Telegram chat.
- Session cookies are HttpOnly and SameSite=Strict; HTTPS uses `__Host-sift`
  with Secure and Path=/. Tokens are hashed in process memory, expire after
  eight hours, and are revoked at restart. At most three sessions per user.
- `/web logout` revokes all the user's sessions and unused links. Browser logout
  revokes that browser session. Pending web requests receive an abort signal.
- Every API call checks the configured Host and current tester allowlist.
  Mutations require exact Origin and a session CSRF token. No CORS is enabled.
- Callback controls use short-lived opaque session IDs and the bot's original
  ownership, revision and admin checks. The browser cannot submit raw callbacks.
- Commands are allowlisted, body size is bounded, actions are serialized per user
  and capped at 20 per minute per session, and provider limits remain in force.
- Browser request receipts use a separate SQLite namespace from Telegram updates.
  Retrying one request cannot advance setup twice or acknowledge Telegram updates.
- Static files are limited to the configured app root and supported asset types;
  hidden files, traversal and symlinks escaping the root are rejected.
- The frontend uses text nodes for provider/user text. CSP forbids inline scripts,
  third-party connections, framing and external form destinations.

This is private-beta access, not public user registration. There is no browser
wallet, trade execution, paid AI enablement, or new risk-verification capability.
Unknown required checks and all unapproved instructions continue to block matches.
The frontend only reads saved candidate checks; refresh does not trigger a scan.

## Tests and verification limits

`test/web.test.js` exercises authentication, one-time link expiration, allowlist
revocation, CSRF and host enforcement, private-file isolation, cross-user access,
stale callbacks, duplicate commands and preservation of unresolved criteria.
It also runs description → review → approval → explicit activation → discovery
against the real store and runner with synthetic providers and Telegram delivery.

The SiftAgent browser integration test checks the same server in Chromium, using
only `test/web-fixture.js`'s isolated in-memory runtime. That fixture is not imported
by the production entrypoint. No live Telegram delivery, real-user sign-in or
public HTTPS deployment has been verified by these automated tests.
