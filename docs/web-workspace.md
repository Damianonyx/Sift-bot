# Shared Telegram and web workspace

`src/web-server.js` exposes an optional same-origin HTTP interface alongside
the existing bot process. It reuses `createResponder`, stores, authorization
and the existing background runners. There is still one poller and one database.
It is disabled by default and adds no dependency or paid API.

The client lives in `Damianonyx/SiftAgent`, under `dist/app`, on branch
`main`. Its `WEB_APP.md` contains setup and browser checks.

Enable with `SIFT_WEB_ENABLED=true`, `SIFT_WEB_ROOT` pointing to that app folder,
`SIFT_WEB_PORT=3000`, and `SIFT_WEB_ORIGIN` set to the exact browser origin. Only
localhost may use HTTP; other origins require HTTPS. Bind to `0.0.0.0` only when
needed for a forwarded port or reverse proxy. Keep the app and API on one origin.

In a Codespace, its forwarded HTTPS port URL is the origin, not the IDE URL.
[Open the existing Codespace](https://effective-carnival-wr5j9v5g9775c95q9.github.dev/).
Private port access remains gated by GitHub as well as Sift. No hosting migration
is included and the runtime must stay running for both interfaces to work.

With both repositories checked out side by side as `Sift-bot` and `SiftAgent`,
run `npm run start:web` from the bot repository in Codespaces. This enables the
web interface on loopback port 3000, uses `../SiftAgent/dist/app`, and derives
the public HTTPS origin from the Codespaces environment. Existing bot credentials
and data settings still load from `.env`; this command does not edit that file.
Stop the previous bot process first. Keep forwarded port 3000 private and send
`/web` again after restarting, since old sign-in links and sessions expire.

Codespaces may rewrite the request Host to `localhost:3000`. When `CODESPACES`
is `true` and the configured HTTPS origin exactly matches this Codespace's name,
port and forwarding domain, the server also accepts local hostnames for that
port from a loopback TCP peer only. Other deployments retain exact public Host
checking. Forwarding headers never select the trusted origin or peer. The tunnel
can also rewrite Origin to its local HTTP(S) address. That origin is accepted
only when it exactly matches the accepted local Host and browser Fetch Metadata
says `Sec-Fetch-Site: same-origin`. Missing, null, foreign, cross-site and
same-site rewritten origins fail. Normal requests still require the exact public
Origin. Cookies remain Secure and authenticated mutations still require the
session CSRF token. Do not change `SIFT_WEB_ORIGIN` to localhost to work around
a forwarded-header error.

## Authentication and mutations

- `/web` or the `start=web` deep link issues a single-use five-minute link only
  to an allowlisted user in their own private Telegram chat.
- Session cookies are HttpOnly and SameSite=Strict; HTTPS uses `__Host-sift`
  with Secure and Path=/. Tokens are hashed in process memory, expire after
  eight hours, and are revoked at restart. At most three sessions per user.
- `/web logout` revokes all the user's sessions and unused links. Browser logout
  revokes that browser session. Pending web requests receive an abort signal.
- Every API call checks the accepted Host and current tester allowlist.
  Mutations require an accepted browser Origin (as above) and a session CSRF
  token. No CORS is enabled.
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
Each saved check includes the backend's rule description alongside its recorded
state and observed value. These descriptions do not add new evidence or re-run
screening. Completed drafts with supported mapping input expose a direct review
button in both Telegram and web reports. Opening it does not mutate the draft;
scope preview, applying the mapping, approval and scan activation remain separate.

## Tests and verification limits

`test/web.test.js` exercises authentication, one-time link expiration, allowlist
revocation, CSRF and host enforcement, private-file isolation, cross-user access,
stale callbacks, duplicate commands and preservation of unresolved criteria.
It also checks sign-in through simulated Codespaces Host and Origin rewrites,
including Secure cookies, logout, denied foreign origins/hosts, missing or
cross-origin Fetch Metadata, and spoofed forwarding headers.
It also runs description → review → approval → explicit activation → discovery
against the real store and runner with synthetic providers and Telegram delivery.

The SiftAgent browser integration test checks the same server in Chromium, using
only `test/web-fixture.js`'s isolated in-memory runtime. That fixture is not imported
by the production entrypoint. No live Telegram delivery, real-user sign-in or
public HTTPS deployment has been verified by these automated tests.

The browser recovery test also covers phone layout, the full scope-review flow,
unknown required evidence preventing alerts, saved-result explanations, connection
outage recovery, preserving monitor input across refreshes, late dialog responses
and clearing private state when a session is revoked.
