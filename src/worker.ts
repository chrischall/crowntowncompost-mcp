import { createConnector } from '@chrischall/mcp-connector';
import { CrownTownClient, createDirectClient } from './client.js';
import { crowntownAuth, type CrownTownProps } from './crowntown-auth.js';
import { registerHealthcheckTools } from './tools/healthcheck.js';
import { registerAccountTools } from './tools/account.js';
import { registerServiceTools } from './tools/service.js';
import { registerBillingTools } from './tools/billing.js';
import { registerSupportTools } from './tools/support.js';
import { VERSION } from './version.js';

// The Cloudflare remote-connector entrypoint: wires the same transport-neutral
// tool registrars the stdio server uses (`src/index.ts`) into
// `@chrischall/mcp-connector`'s generic OAuth + McpAgent harness, making the
// server reachable from claude.ai (web/desktop/mobile).
//
// This archetype is connector-safe: auth is a real server-side Django form login
// over plain HTTPS — no browser bridge, no signed-in tab, no filesystem. Each
// user logs in on the connector's own OAuth page with their personal portal
// credentials (`src/crowntown-auth.ts`), and `buildClient` mints a per-user
// client whose injected credentials let it re-run the form login as the session
// cookie expires, so concurrent sessions never share a cookie jar.
//
// Crown Town Compost is STATELESS — there is no local cache, so this Worker
// declares only the `MCP_OBJECT` per-session agent Durable Object (no cache DO).
// No tool touches the filesystem, so the FULL tool surface is hosted.
const { Agent, handler } = createConnector<CrownTownProps, CrownTownClient>({
  name: 'crowntowncompost-mcp',
  version: VERSION,
  auth: crowntownAuth,
  buildClient: (props) => createDirectClient({ username: props.username, password: props.password }),
  // Keep the SAME order as src/index.ts.
  tools: [
    registerHealthcheckTools,
    registerAccountTools,
    registerServiceTools,
    registerBillingTools,
    registerSupportTools,
  ],
});

// The connector's per-session MCP agent Durable Object
// (`wrangler.jsonc`'s `MCP_OBJECT` → `CrownTownMcpAgent`) resolves this export.
export { Agent as CrownTownMcpAgent };

export default handler;
