import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestHarness } from './helpers.js';
import { client } from '../src/client.js';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';
import { registerAccountTools } from '../src/tools/account.js';
import { registerServiceTools } from '../src/tools/service.js';
import { registerBillingTools } from '../src/tools/billing.js';
import { registerSupportTools } from '../src/tools/support.js';

/**
 * Fleet annotation invariants, read off the REGISTERED tools rather than a
 * hand-kept list. `destructiveHint` defaults to TRUE whenever readOnlyHint is
 * false, so a write that forgets to declare it is published as destructive and
 * nothing fails — a considered `false` and a forgotten one look identical.
 * The invariant worth pinning is that each write CHOOSES.
 */
let harness: Awaited<ReturnType<typeof createTestHarness>>;
type Tool = Awaited<ReturnType<typeof harness.client.listTools>>['tools'][number];
let tools: Tool[];

beforeAll(async () => {
  harness = await createTestHarness((s) => {
    registerHealthcheckTools(s, client);
    registerAccountTools(s, client);
    registerServiceTools(s, client);
    registerBillingTools(s, client);
    registerSupportTools(s, client);
  });
  tools = (await harness.client.listTools()).tools;
});
afterAll(async () => { if (harness) await harness.close(); });

const readJson = (p: string) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));

describe('tool annotations', () => {
  it('covers the full surface (guards against a registrar being dropped here)', () => {
    expect(tools).toHaveLength(11);
  });

  it('sets an explicit boolean readOnlyHint and openWorldHint on every tool', () => {
    const missing = tools
      .filter((t) => typeof t.annotations?.readOnlyHint !== 'boolean' || typeof t.annotations?.openWorldHint !== 'boolean')
      .map((t) => t.name);
    expect(missing).toEqual([]);
  });

  it('sets an explicit boolean destructiveHint on every write', () => {
    const undeclared = tools
      .filter((t) => t.annotations?.readOnlyHint === false && typeof t.annotations?.destructiveHint !== 'boolean')
      .map((t) => t.name);
    expect(undeclared).toEqual([]);
  });

  it('never lets a read claim to be destructive', () => {
    const contradictory = tools
      .filter((t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === true)
      .map((t) => t.name);
    expect(contradictory).toEqual([]);
  });

  it('marks the tools that reach Crown Town staff destructive, and the self-reversible ones not', () => {
    // report_missed_pickup notifies staff and contact_support sends a message:
    // neither can be called back. skip_service is undone by action "unskip";
    // update_account by re-saving the prior values the preview shows.
    const destructive = Object.fromEntries(
      tools.filter((t) => t.annotations?.readOnlyHint === false).map((t) => [t.name, t.annotations?.destructiveHint]),
    );
    expect(destructive).toEqual({
      crowntown_contact_support: true,
      crowntown_report_missed_pickup: true,
      crowntown_skip_service: false,
      crowntown_update_account: false,
    });
  });
});

describe('manifest.json stays in sync with the served surface', () => {
  it('lists exactly the served tools', () => {
    const manifest = readJson('manifest.json');
    const listed = (manifest.tools as { name: string }[]).map((t) => t.name).sort();
    expect(listed).toEqual(tools.map((t) => t.name).sort());
  });

  it('passes every env var server.json documents through mcp_config.env', () => {
    const manifest = readJson('manifest.json');
    const serverJson = readJson('server.json');
    const documented = (serverJson.packages[0].environmentVariables as { name: string }[]).map((v) => v.name).sort();
    expect(Object.keys(manifest.server.mcp_config.env).sort()).toEqual(documented);
    // ...and each one is wired to a user_config entry that exists.
    for (const [name, value] of Object.entries(manifest.server.mcp_config.env as Record<string, string>)) {
      const ref = /^\$\{user_config\.([^}]+)\}$/.exec(value)?.[1];
      expect(ref, name).toBeDefined();
      expect(manifest.user_config[ref!], name).toBeDefined();
    }
  });
});
