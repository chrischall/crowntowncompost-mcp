#!/usr/bin/env node
import { runMcp } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VERSION } from './version.js';
import { client } from './client.js';
import { registerHealthcheckTools } from './tools/healthcheck.js';
import { registerServiceTools } from './tools/service.js';
import { registerBillingTools } from './tools/billing.js';
import { registerAccountTools } from './tools/account.js';
import { registerSupportTools } from './tools/support.js';

// The client is a module-level singleton (constructed in client.ts) so the
// deferred-config-error pattern holds: the server boots and answers the host's
// install-time tools/list probe even without CROWNTOWN_USERNAME/PASSWORD — the
// config error only surfaces on the first tool call.
const tools: Array<(server: McpServer) => void> = [
  (s) => registerHealthcheckTools(s, client),
  (s) => registerAccountTools(s, client),
  (s) => registerServiceTools(s, client),
  (s) => registerBillingTools(s, client),
  (s) => registerSupportTools(s, client),
];

await runMcp({
  name: 'crowntowncompost-mcp',
  version: VERSION,
  banner: `[crowntowncompost-mcp] v${VERSION} — customer access to the Crown Town Compost portal via username/password login. This project was developed and is maintained by AI (Claude). Use at your own discretion.`,
  tools,
});
