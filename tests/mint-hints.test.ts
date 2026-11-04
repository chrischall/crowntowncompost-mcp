import { describe, it, expect, afterEach } from 'vitest';
import { createTestHarness } from './helpers.js';
import { CrownTownClient } from '../src/client.js';
import { AuthManager } from '../src/auth.js';
import type { PortalRequest, PortalResponse, PortalTransport } from '../src/transport.js';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';
import { registerAccountTools } from '../src/tools/account.js';
import { registerServiceTools } from '../src/tools/service.js';
import { registerBillingTools } from '../src/tools/billing.js';
import { registerSupportTools } from '../src/tools/support.js';
import { CALENDAR_HTML, LOGIN_PAGE_HTML } from './fixtures/pages.js';

/**
 * The mcp-host context-groups contract (`_meta.mint`), asserted against the
 * SERVED tool list rather than a hand-kept table, so a tool added later without
 * a hint fails here.
 */

function res(partial: Partial<PortalResponse> = {}): PortalResponse {
  return { status: 200, body: '', url: 'https://portal.crowntowncompost.com/accounts/', setCookie: [], contentType: 'text/html', ...partial };
}
const json = (obj: unknown): PortalResponse => res({ body: JSON.stringify(obj), contentType: 'application/json' });

class MockTransport implements PortalTransport {
  constructor(private readonly handler: (req: PortalRequest) => PortalResponse) {}
  async request(req: PortalRequest): Promise<PortalResponse> {
    if (req.path.includes('/accounts/login/')) {
      return req.method === 'GET'
        ? res({ body: LOGIN_PAGE_HTML, setCookie: ['csrftoken=CSRFCOOKIE; Path=/'] })
        : res({ status: 302, location: '/accounts/', setCookie: ['sessionid=SESSION; Path=/; HttpOnly'] });
    }
    return this.handler(req);
  }
}

let harness: Awaited<ReturnType<typeof createTestHarness>> | undefined;
afterEach(async () => {
  if (harness) await harness.close();
  harness = undefined;
});

async function setup(handler: (req: PortalRequest) => PortalResponse = () => res()) {
  const transport = new MockTransport(handler);
  const auth = new AuthManager(transport, { username: 'u', password: 'p' });
  const client = new CrownTownClient({ transport, auth });
  harness = await createTestHarness((s) => {
    registerHealthcheckTools(s, client);
    registerAccountTools(s, client);
    registerServiceTools(s, client);
    registerBillingTools(s, client);
    registerSupportTools(s, client);
  });
  return harness;
}

type Listed = {
  name: string;
  annotations?: { readOnlyHint?: boolean };
  inputSchema: { properties?: Record<string, any> };
  _meta?: { mint?: Record<string, any> };
};

async function served(): Promise<Listed[]> {
  const h = await setup();
  return (await h.client.listTools()).tools as Listed[];
}

async function text(name: string, args: Record<string, unknown>, handler: (req: PortalRequest) => PortalResponse): Promise<string> {
  const h = await setup(handler);
  const out = (await h.callTool(name, args)) as { content: { type: string; text: string }[]; isError?: boolean };
  expect(out.isError, JSON.stringify(out)).toBeFalsy();
  return out.content[0]!.text;
}

const DOMAINS = ['school', 'home', 'work', 'family', 'health', 'money', 'travel', 'food'];
const INTENTS = ['whats-new', 'whats-due', 'whats-on', 'lookup', 'turn-on-off', 'send', 'change', 'other'];
const KEYS = ['domain', 'intent', 'canonical', 'subject', 'when', 'aliases'];
const BRIEF_LINE = /^.+ — (\d{4}-\d{2}-\d{2}|no date) — .+$/;

describe('_meta.mint hints', () => {
  it('every tool except the healthcheck carries domain "home" and a valid intent, in the contract shape', async () => {
    const tools = await served();
    expect(tools).toHaveLength(11);
    for (const t of tools) {
      if (t.name.endsWith('_healthcheck')) continue;
      const m = t._meta?.mint;
      expect(m, t.name).toBeDefined();
      expect(Object.keys(m!).every((k) => KEYS.includes(k)), t.name).toBe(true);
      expect(DOMAINS).toContain(m!.domain);
      expect(m!.domain, t.name).toBe('home');
      expect(INTENTS, t.name).toContain(m!.intent);
    }
  });

  it('aliases are everyday words: at most 8, lowercase, at most 40 chars', async () => {
    for (const t of await served()) {
      const aliases = t._meta?.mint?.aliases as string[] | undefined;
      if (!aliases) continue;
      expect(aliases.length, t.name).toBeLessThanOrEqual(8);
      for (const a of aliases) {
        expect(a, t.name).toBe(a.toLowerCase());
        expect(a.length, t.name).toBeLessThanOrEqual(40);
        expect(a.startsWith('crowntown_'), t.name).toBe(false);
      }
    }
  });

  it('a subject or when names arguments the tool really takes', async () => {
    for (const t of await served()) {
      const m = t._meta?.mint;
      if (!m) continue;
      const props = t.inputSchema.properties ?? {};
      if (m.subject !== undefined) expect(props, t.name).toHaveProperty(m.subject);
      if (m.when !== undefined) {
        expect(props, t.name).toHaveProperty(m.when.start);
        expect(props, t.name).toHaveProperty(m.when.end);
      }
    }
  });

  it('canonical only on read-only whats-new/due/on reads, at most one per intent, each taking view "brief"', async () => {
    const canon = (await served()).filter((t) => t._meta?.mint?.canonical !== undefined);
    const perIntent = new Map<string, string[]>();
    for (const t of canon) {
      const m = t._meta!.mint!;
      expect(m.canonical, t.name).toBe(true);
      expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      expect(['whats-new', 'whats-due', 'whats-on'], t.name).toContain(m.intent);
      perIntent.set(m.intent, [...(perIntent.get(m.intent) ?? []), t.name]);
      expect(t.inputSchema.properties?.view?.enum, t.name).toContain('brief');
    }
    for (const [intent, names] of perIntent) expect(names, intent).toHaveLength(1);
  });

  it('assigns the intent that fits each tool', async () => {
    const intents = Object.fromEntries(
      (await served()).filter((t) => t._meta?.mint).map((t) => [t.name, t._meta!.mint!.intent]),
    );
    expect(intents).toEqual({
      crowntown_get_dashboard: 'lookup',
      crowntown_get_account: 'lookup',
      crowntown_update_account: 'change',
      crowntown_list_service_history: 'lookup',
      crowntown_list_upcoming_services: 'whats-on',
      crowntown_get_pickup_schedule: 'lookup',
      crowntown_skip_service: 'change',
      crowntown_list_invoices: 'whats-due',
      crowntown_report_missed_pickup: 'send',
      crowntown_contact_support: 'send',
    });
  });

  it('the canonical reads are the upcoming pickups (whats-on) and the open invoices (whats-due), with no subject', async () => {
    const tools = await served();
    const canonical = tools.filter((t) => t._meta?.mint?.canonical).map((t) => t.name).sort();
    expect(canonical).toEqual(['crowntown_list_invoices', 'crowntown_list_upcoming_services']);
    // One account, nothing listable to choose between: no subject anywhere.
    for (const t of tools) expect(t._meta?.mint?.subject, t.name).toBeUndefined();
  });
});

describe('crowntown_list_upcoming_services view "brief"', () => {
  it('answers one line per day, "title — ISO date — status", as bare lines (no third-party text)', async () => {
    const out = await text('crowntown_list_upcoming_services', { view: 'brief' }, () => res({ body: CALENDAR_HTML }));
    const lines = out.split('\n');
    expect(lines).toEqual([
      'Compost pickup — 2026-08-07 — scheduled',
      'Compost pickup — 2026-08-14 — scheduled',
      'Compost pickup — 2026-08-21 — skipped',
    ]);
    for (const l of lines) {
      expect(l).toMatch(BRIEF_LINE);
      expect(l.length).toBeLessThanOrEqual(120);
    }
  });

  it('says "-- none" when nothing is upcoming', async () => {
    expect(await text('crowntown_list_upcoming_services', { view: 'brief' }, () => res({ body: '<html></html>' }))).toBe('-- none');
  });

  it('reads an undated day as "no date"', async () => {
    const html = '<button class="submit-skip" data-action="skip" data-clid="1" data-rid="2" data-route-date="">Skip</button>';
    expect(await text('crowntown_list_upcoming_services', { view: 'brief' }, () => res({ body: html }))).toBe('Compost pickup — no date — scheduled');
  });

  it('reads an unrecognised button action as "unknown" rather than guessing', async () => {
    const html = '<button class="submit-skip" data-action="hold" data-clid="1" data-rid="2" data-route-date="Aug. 7, 2026">?</button>';
    expect(await text('crowntown_list_upcoming_services', { view: 'brief' }, () => res({ body: html }))).toBe('Compost pickup — 2026-08-07 — unknown');
  });

  it('keeps the full answer by default', async () => {
    const out = JSON.parse(await text('crowntown_list_upcoming_services', {}, () => res({ body: CALENDAR_HTML })));
    expect(out.count).toBe(3);
  });
});

describe('crowntown_list_invoices view "brief"', () => {
  const row = (id: number, payable: boolean, over: Record<string, unknown> = {}) => ({
    RecordID: id, number: `INV-${id}`, date: 'Aug 1, 2026', amount: '$44.00', status: payable ? 'open' : 'paid',
    invoice_pdf: '', receipt_url: '', hosted_invoice_url: '', is_payable: payable, invoice_id: id, ...over,
  });
  const page = (data: unknown[], pages = 1, total = data.length) =>
    json({ meta: { page: 1, pages, perpage: 100, total, sort: 'desc', field: 'date' }, qs: '', data });

  const envelope = (out: string) => {
    const parsed = JSON.parse(out);
    expect(parsed.untrusted_content).toBe(true);
    expect(parsed.note).toMatch(/Crown Town Compost/);
    expect(Array.isArray(parsed.data)).toBe(true);
    return parsed.data as string[];
  };

  it('defaults to the payable invoices and answers lines inside the untrusted-data envelope', async () => {
    const out = await text('crowntown_list_invoices', { view: 'brief' }, () => page([row(1, false), row(2, true, { date: 'Jul 1, 2026' })]));
    const lines = envelope(out);
    expect(lines).toEqual(['Invoice INV-2 $44.00 — 2026-07-01 — open']);
    for (const l of lines) {
      expect(l).toMatch(BRIEF_LINE);
      expect(l.length).toBeLessThanOrEqual(120);
    }
  });

  it('says "-- none" inside the envelope when nothing is owed', async () => {
    expect(envelope(await text('crowntown_list_invoices', { view: 'brief' }, () => page([row(1, false)])))).toEqual(['-- none']);
  });

  it('notes a partial page as "-- N of M shown"', async () => {
    const out = await text('crowntown_list_invoices', { view: 'brief', per_page: 1 }, () => page([row(1, true), row(2, true), row(3, true)]));
    expect(envelope(out)).toEqual(['Invoice INV-1 $44.00 — 2026-08-01 — open', '-- 1 of 3 shown']);
  });

  it('honours an explicit payable_only: false', async () => {
    const out = await text('crowntown_list_invoices', { view: 'brief', payable_only: false }, () => page([row(1, false), row(2, true)], 2, 5));
    expect(envelope(out)).toEqual([
      'Invoice INV-1 $44.00 — 2026-08-01 — paid',
      'Invoice INV-2 $44.00 — 2026-08-01 — open',
      '-- 2 of 5 shown',
    ]);
  });

  it('shortens a long line to 120 chars and keeps the date and status', async () => {
    const out = await text('crowntown_list_invoices', { view: 'brief' }, () => page([row(1, true, { number: 'X'.repeat(200) })]));
    const [line] = envelope(out);
    expect(line!.length).toBeLessThanOrEqual(120);
    expect(line).toMatch(/… — 2026-08-01 — open$/);
  });

  it('keeps the full answer (all invoices) by default', async () => {
    const out = JSON.parse(await text('crowntown_list_invoices', {}, () => page([row(1, false), row(2, true)])));
    expect(out.total).toBe(2);
  });
});
