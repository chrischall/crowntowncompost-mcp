import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import { runCredentialHealthcheck } from '@chrischall/mcp-utils/healthcheck';
import { SessionNotReestablishedError, type CrownTownClient } from '../client.js';
import { parseDashboard, type DashboardSummary } from '../parse.js';
import { LoginRejectedError, StaleSessionCookieError } from '../auth.js';

const NO_CREDENTIAL_HINT =
  'Crown Town Compost is not configured — set CROWNTOWN_SESSION_COOKIE (a signed-in portal session you already hold), ' +
  'or CROWNTOWN_USERNAME and CROWNTOWN_PASSWORD to log in for one, in .env or the MCP host env, then retry.';

/**
 * Name the portal failures the shared status ladder cannot see — they carry no
 * HTTP status. Anything else (an edge block, a timeout, a 5xx) falls through to
 * the shared ladder (chrischall/mcp-host#1015).
 */
export function classifyCrownTownError(err: unknown): { kind: string; hint?: string } | undefined {
  if (err instanceof LoginRejectedError) {
    return {
      kind: 'credential_rejected',
      hint: 'portal.crowntowncompost.com refused the login — verify CROWNTOWN_USERNAME (username or email) and CROWNTOWN_PASSWORD.',
    };
  }
  if (err instanceof StaleSessionCookieError) return { kind: 'session_expired', hint: err.message };
  if (err instanceof SessionNotReestablishedError) return { kind: 'session_expired', hint: err.hint };
  return undefined;
}

export function registerHealthcheckTools(
  server: McpServer,
  client: CrownTownClient,
): void {
  server.registerTool(
    'crowntown_healthcheck',
    {
      title: 'Verify Crown Town Compost auth + connectivity',
      description:
        "Confirm credentials are configured, log in to the Crown Town Compost portal, fetch the dashboard, and report {authenticated, account_status, service_addresses}. On failure, error.kind says which hop broke: no_credential (nothing configured), credential_rejected (the portal refused the username/password), session_expired (a supplied session cookie is no longer honoured), edge_blocked (a CDN/WAF refused the request before the portal saw it, so the credentials were never judged), timeout, transport or http. Read-only; never returns the credentials.",
      annotations: toolAnnotations({
        title: 'Verify Crown Town auth + connectivity',
        readOnly: true,
        idempotent: true,
        openWorld: true,
      }),
      inputSchema: z.object({}),
    },
    async () => {
      let dash: DashboardSummary | undefined;
      const shared = await runCredentialHealthcheck({
        server,
        prefix: 'crowntown',
        hostLabel: 'portal.crowntowncompost.com',
        probePath: '/accounts/',
        resolveCredential: async () => ({ source: client.credentialSource() }),
        probeFn: async () => {
          dash = parseDashboard(await client.fetchHtml('/accounts/'));
        },
        classifyThrown: classifyCrownTownError,
        hints: { no_credential: NO_CREDENTIAL_HINT },
      });
      const result = JSON.parse(shared.content[0]!.text) as { ok: boolean; hint: string } & Record<string, unknown>;
      if (dash === undefined) return minifiedResult({ ...result, authenticated: false });
      const parsed = Boolean(dash.account_status) || dash.service_addresses.length > 0;
      return minifiedResult({
        ...result,
        authenticated: true,
        account_status: dash.account_status,
        service_addresses: dash.service_addresses.length,
        hint: parsed
          ? 'Logged in; dashboard parsed successfully.'
          : 'Logged in, but the dashboard did not parse — the portal markup may have changed.',
      });
    },
  );
}
