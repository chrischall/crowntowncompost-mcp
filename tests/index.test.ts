import { describe, it, expect, afterAll } from 'vitest';
import { createTestHarness } from './helpers.js';
import { client } from '../src/client.js';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';
import { registerAccountTools } from '../src/tools/account.js';
import { registerServiceTools } from '../src/tools/service.js';
import { registerBillingTools } from '../src/tools/billing.js';
import { registerSupportTools } from '../src/tools/support.js';

let harness: Awaited<ReturnType<typeof createTestHarness>>;
afterAll(async () => { if (harness) await harness.close(); });

describe('full tool surface', () => {
  it('registers the complete tool roster', async () => {
    harness = await createTestHarness((s) => {
      registerHealthcheckTools(s, client);
      registerAccountTools(s, client);
      registerServiceTools(s, client);
      registerBillingTools(s, client);
      registerSupportTools(s, client);
    });
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
  });

  // `harness.listTools()` returns names only, so read the full metadata off the
  // raw MCP client to assert annotations + the confirm gate.
  const fullTools = async () => (await harness.client.listTools()).tools;

  it('marks every mutating tool as non-readOnly and gives it a confirm gate', async () => {
    const tools = await fullTools();
    const writes = ['crowntown_skip_service', 'crowntown_update_account', 'crowntown_report_missed_pickup', 'crowntown_contact_support'];
    for (const name of writes) {
      const t = tools.find((x) => x.name === name)!;
      expect(t.annotations?.readOnlyHint, name).toBe(false);
      expect(Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}), name).toContain('confirm');
    }
  });

  it('marks every read tool readOnly', async () => {
    const tools = await fullTools();
    const reads = ['crowntown_healthcheck', 'crowntown_get_dashboard', 'crowntown_get_account', 'crowntown_list_service_history', 'crowntown_list_upcoming_services', 'crowntown_list_invoices'];
    for (const name of reads) {
      expect(tools.find((x) => x.name === name)!.annotations?.readOnlyHint, name).toBe(true);
    }
  });
});
