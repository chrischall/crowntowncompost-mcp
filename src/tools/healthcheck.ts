import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult, toolAnnotations, messageOf } from '@chrischall/mcp-utils';
import type { CrownTownClient } from '../client.js';
import { parseDashboard } from '../parse.js';

export function registerHealthcheckTools(server: McpServer, client: CrownTownClient): void {
  server.registerTool(
    'crowntown_healthcheck',
    {
      title: 'Verify Crown Town Compost auth + connectivity',
      description:
        'Confirm credentials are configured, log in to the Crown Town Compost portal, fetch the dashboard, and report {authenticated, account_status, service_addresses} with a plain-English hint distinguishing "no creds" vs "bad creds" vs "site error". Read-only.',
      annotations: toolAnnotations({ title: 'Verify Crown Town auth + connectivity', readOnly: true, idempotent: true, openWorld: true }),
      inputSchema: {},
    },
    async () => {
      try {
        const dash = parseDashboard(await client.fetchHtml('/accounts/'));
        return textResult({
          ok: true,
          authenticated: true,
          account_status: dash.account_status,
          service_addresses: dash.service_addresses.length,
          hint:
            dash.account_status || dash.service_addresses.length
              ? 'Logged in; dashboard parsed successfully.'
              : 'Logged in, but the dashboard did not parse — the portal markup may have changed.',
        });
      } catch (e) {
        const msg = messageOf(e);
        const noCreds = /environment variables are required/.test(msg);
        return textResult({
          ok: false,
          authenticated: false,
          error: msg,
          hint: noCreds
            ? 'Set CROWNTOWN_USERNAME and CROWNTOWN_PASSWORD (in .env or the MCP host env), then retry.'
            : 'Login or fetch failed — verify your portal.crowntowncompost.com username/email and password are correct.',
        });
      }
    },
  );
}
