# Deploying the hosted connector

The connector is a Cloudflare Worker (`src/worker.ts`) that makes this MCP server
reachable from **claude.ai** (web, desktop, mobile) instead of only from a local
stdio host. It wraps the same tool registrars the stdio server uses, behind an
OAuth login page where each user supplies their own Crown Town Compost portal
credentials.

Deploy is **manual, in the operator's Cloudflare account** — there is no CI deploy
on push. (`release-please.yml` does deploy at a released tag, but only when
`CLOUDFLARE_API_TOKEN` is present as a repo secret; without it the job warns and
skips rather than failing.)

## Why this archetype can be hosted

The portal authenticates with a real **server-side Django form login** over plain
HTTPS — no browser extension, no signed-in tab, no filesystem. That works fine in
a serverless runtime. Because the portal issues no long-lived refresh token, the
user's username and password are stored in the OAuth props (encrypted at rest in
`OAUTH_KV`) so the per-user client can silently re-login when the session cookie
expires. The login page says so plainly; do not weaken that wording.

## One-time setup

1. **Authenticate wrangler.** Either `wrangler login`, or set `CLOUDFLARE_API_TOKEN`
   to a token with **Workers Scripts:Edit + Workers KV Storage:Edit** (the "Edit
   Cloudflare Workers" template). A read-only or zone-only token fails KV-create
   and deploy with `code: 10000` auth errors.

   `CLOUDFLARE_ACCOUNT_ID` is **not** required when the token is scoped to a single
   account — wrangler infers it. Set it only if the token can reach more than one.

2. **Create this connector's own KV namespace.** Each connector needs its own, or
   two connectors cross-wire their OAuth grants:

   ```sh
   wrangler kv namespace create crowntowncompost-connector-oauth
   ```

   > **Take only the `id` from the output.** Wrangler prints a ready-to-paste
   > snippet whose `binding` is derived from the title
   > (`crowntowncompost_connector_oauth`). Do **not** use that binding name:
   > `@chrischall/mcp-connector`'s OAuth provider resolves the literal name
   > `OAUTH_KV`. Adopting the suggested name deploys cleanly and then fails at
   > *login*, because the provider finds no store for its grants — and
   > `wrangler deploy --dry-run` prints the wrong binding as if it were fine.

   Paste the id into `wrangler.jsonc`'s `kv_namespaces[0].id`, leaving
   `"binding": "OAUTH_KV"` untouched. (The current id is already committed.)

3. **Deploy.**

   ```sh
   npm run worker:deploy
   ```

## Verify

```sh
wrangler deployments list          # confirm something actually shipped
```

Then exercise the OAuth surface:

```sh
curl -s https://crowntowncompost-connector.<subdomain>.workers.dev/.well-known/oauth-authorization-server | jq
```

The `/register` → `/authorize` flow is what claude.ai drives (it does Dynamic
Client Registration first). Hitting `/authorize` with a bogus `client_id` returns
a 500 — that is expected, not a broken deploy.

The custom domain `connector.crowntowncompost.nullnet.app` needs the `nullnet.app`
zone in the deploying account. Its edge TLS certificate provisions a few minutes
**after** the deploy, so `https://` may refuse connections or fail the handshake in
the meantime — use the `*.workers.dev` URL until it self-heals.

## Gotchas that have bitten this fleet

- **A green job is not a deploy.** The connector-deploy composite *warns and skips*
  when `CLOUDFLARE_API_TOKEN` is absent, so the job goes green while nothing
  shipped. Check `wrangler deployments list`, not the job's conclusion.
- **`.env` loading and global scope.** `src/client.ts` guards its `.env` load in a
  `try/catch` (in a Worker `import.meta.url` is undefined and `fileURLToPath` would
  throw at startup validation), and the module-level `client` singleton's
  constructor is pure — no fetch, timers, or random values in global scope, which
  workerd forbids. Neither trap is caught by `worker:test` or
  `wrangler deploy --dry-run`; only a real deploy validates them. Keep both
  properties when editing `client.ts`.
- **Detached `fetch`.** `FetchTransport` calls the bare global `fetch(...)`. Never
  rewrite that as `globalThis.fetch` stored on a property and called detached —
  workerd throws "Illegal invocation" on every request, and only a live request
  reveals it. `tests/worker.test.ts` guards this.

## Testing

```sh
npm run worker:test    # Workers pool (Miniflare), against wrangler.jsonc
npm test               # Node pool; excludes tests/worker.test.ts
```
