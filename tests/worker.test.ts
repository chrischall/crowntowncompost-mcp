import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { createDirectClient } from '../src/client.js';

import { registerHealthcheckTools } from '../src/tools/healthcheck.js';
import { registerAccountTools } from '../src/tools/account.js';
import { registerServiceTools } from '../src/tools/service.js';
import { registerBillingTools } from '../src/tools/billing.js';
import { registerSupportTools } from '../src/tools/support.js';

// Handshake + tool-surface tests for the Crown Town Compost Cloudflare remote
// connector, run inside the REAL Workers runtime (Miniflare) via
// `@cloudflare/vitest-pool-workers` against `wrangler.jsonc`. They prove what
// can be checked without a live portal session:
//   1. the OAuth default handler serves discovery + the login page,
//   2. an unauthenticated `/mcp` request is rejected before any tool code runs,
//   3. the exact registrar wiring `src/worker.ts` uses registers the full tool
//      surface under workerd.
//
// The full authenticated `/mcp` handshake needs a real OAuth access token minted
// through the KV-backed grant flow, which would mean a live portal login — out
// of scope for a hermetic in-process test.
//
// Nothing here may reach the network. An earlier revision drove a real request
// through the client to probe the fetch binding, which sent a live failed-login
// POST to the production portal on every CI run; see the note at the bottom for
// why that test could not have worked anyway.

describe('Crown Town Compost connector — OAuth surface', () => {
  it('serves the OAuth authorization-server discovery document', async () => {
    const res = await SELF.fetch('https://example.com/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    const meta = (await res.json()) as { authorization_endpoint?: string; token_endpoint?: string };
    expect(meta.authorization_endpoint).toContain('/authorize');
    expect(meta.token_endpoint).toContain('/token');
  });

  it('rejects an unauthenticated /mcp request', async () => {
    const res = await SELF.fetch('https://example.com/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('GET /authorize renders the login page with the username + password fields', async () => {
    // `redirect_uri` IS required — since workers-oauth-provider 0.8.x,
    // `parseAuthRequest` validates the redirect URI scheme unconditionally and
    // rejects the empty string an absent `redirect_uri` becomes.
    const res = await SELF.fetch(
      'https://example.com/authorize?response_type=code&state=abc' +
        `&redirect_uri=${encodeURIComponent('https://example.com/callback')}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Crown Town Compost');
    expect(html).toContain('Portal username or email');
    expect(html).toContain('Portal password');
    expect(html).toContain('type="password"');
  });
});

describe('Crown Town Compost connector — tool surface under workerd', () => {
  it('registers the full tool roster with the same wiring worker.ts uses', async () => {
    const client = createDirectClient({ username: 'u', password: 'p' });
    const harness = await createTestHarness((s) => {
      registerHealthcheckTools(s, client);
      registerAccountTools(s, client);
      registerServiceTools(s, client);
      registerBillingTools(s, client);
      registerSupportTools(s, client);
    });
    try {
      const names = (await harness.listTools()).map((t) => t.name).sort();
      expect(names).toEqual([
        'crowntown_contact_support',
        'crowntown_get_account',
        'crowntown_get_dashboard',
        'crowntown_healthcheck',
        'crowntown_list_invoices',
        'crowntown_list_service_history',
        'crowntown_list_upcoming_services',
        'crowntown_report_missed_pickup',
        'crowntown_skip_service',
        'crowntown_update_account',
      ]);
    } finally {
      await harness.close();
    }
  });

  // NOTE on the detached-`globalThis.fetch` trap (a real deployed-connector
  // failure elsewhere in this fleet): it CANNOT be caught from this suite. The
  // Workers pool replaces the global `fetch` with its own wrapper — verified
  // here: `Function.prototype.toString` on it does not report [native code] —
  // so a detached call that throws "Illegal invocation" against the deployed
  // runtime resolves normally under Miniflare. A runtime assertion in this file
  // passes either way, i.e. it is a false green. `tests/transport-binding.test.ts`
  // guards the code shape instead; see the reasoning there.
});
