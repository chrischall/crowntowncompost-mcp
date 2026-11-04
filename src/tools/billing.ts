import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { CrownTownClient } from '../client.js';
import { briefDate, briefLine, untrustedBriefResponse, withNotes } from '../brief.js';
import { homeMeta } from './hints.js';

/** A row from POST /accounts/billing-history/api/. */
interface InvoiceRow {
  RecordID: number;
  number: string;
  date: string;
  amount: string;
  status: string;
  invoice_pdf: string;
  receipt_url: string;
  hosted_invoice_url: string;
  is_payable: boolean;
  invoice_id: number;
}

export function registerBillingTools(server: McpServer, client: CrownTownClient): void {
  server.registerTool(
    'crowntown_list_invoices',
    {
      title: 'List billing history (invoices)',
      description:
        'List your Crown Town Compost invoices — number, date, amount, status, whether payable, and links (Stripe PDF / receipt / hosted invoice page). Paginated. view "brief" answers one line per invoice instead ("Invoice <number> <amount> — <ISO date> — <status>", inside the untrusted-data envelope) and lists only the payable invoices unless payable_only is false. Read-only.',
      annotations: toolAnnotations({ title: 'List invoices', readOnly: true, idempotent: true, openWorld: true }),
      _meta: homeMeta('whats-due', { canonical: true, aliases: ['compost bill', 'compost invoice', 'compost payment'] }),
      inputSchema: z.object({
        page: z.number().int().positive().default(1).describe('1-based page number.'),
        per_page: z.number().int().positive().max(100).default(20).describe('Rows per page (max 100).'),
        payable_only: z
          .boolean()
          .optional()
          // Published as `default: false` (the full view's default). Not `.default(false)`:
          // that would fill the argument in before the handler, and brief needs to see it absent.
          .meta({ default: false })
          .describe('Return only open/payable invoices, searched across your whole billing history; page/per_page/total then describe the payable invoices. Defaults to false, or to true with view "brief" (what is due).'),
        view: z
          .enum(['full', 'brief'])
          .optional()
          .describe('"full" (default) returns each invoice with its links; "brief" returns one line per invoice: Invoice <number> <amount> — <ISO date or "no date"> — <status>, inside the untrusted-data envelope.'),
      }),
    },
    async ({ page, per_page, payable_only, view }) => {
      const brief = view === 'brief';
      const listing = await listInvoices(client, page, per_page, payable_only ?? brief);
      if (brief) {
        const lines = listing.invoices.map((i) => briefLine(`Invoice ${i.number} ${i.amount}`, briefDate(i.date), i.status || 'unknown'));
        return untrustedBriefResponse(
          withNotes(lines, listing.total),
          'Invoice numbers, amounts and statuses come from the Crown Town Compost billing portal.',
        );
      }
      return minifiedResult({
        ...listing,
        note: 'To pay an open invoice, open its hosted_invoice_url in a browser — this server does not process payments.',
      });
    },
  );
}

/** One page of invoices, or one page of the payable ones searched across every page. */
async function listInvoices(client: CrownTownClient, page: number, per_page: number, payable_only: boolean) {
  if (!payable_only) {
    const res = await fetchPage(client, page, per_page);
    return {
      page: res.meta?.page,
      pages: res.meta?.pages,
      per_page: res.meta?.perpage,
      total: res.meta?.total,
      invoices: (res.data ?? []).map(toInvoice),
    };
  }
  // The portal has no server-side "payable" filter, so filtering one page
  // would hide open invoices on the others. Walk every page, filter, then
  // paginate the filtered list so page/pages/total describe what is returned.
  const payable: ReturnType<typeof toInvoice>[] = [];
  for (let p = 1; p <= MAX_SCAN_PAGES; p++) {
    const res = await fetchPage(client, p, SCAN_PER_PAGE);
    for (const r of res.data ?? []) if (r.is_payable) payable.push(toInvoice(r));
    if (p >= (res.meta?.pages ?? 1)) break;
  }
  const start = (page - 1) * per_page;
  return {
    page,
    pages: Math.max(1, Math.ceil(payable.length / per_page)),
    per_page,
    total: payable.length,
    invoices: payable.slice(start, start + per_page),
  };
}

/** Rows fetched per request while scanning for payable invoices (the tool's max). */
const SCAN_PER_PAGE = 100;
/** Upper bound on that scan — 10,000 invoices is far beyond any household account. */
const MAX_SCAN_PAGES = 100;

function fetchPage(client: CrownTownClient, page: number, perpage: number) {
  return client.datatable<InvoiceRow>('/accounts/billing-history/api/', {
    page,
    perpage,
    sortField: 'date',
    sortDir: 'desc',
  });
}

function toInvoice(r: InvoiceRow) {
  return {
    id: r.RecordID,
    number: r.number,
    date: r.date,
    amount: r.amount,
    status: r.status,
    is_payable: r.is_payable,
    invoice_pdf: r.invoice_pdf || undefined,
    receipt_url: r.receipt_url || undefined,
    hosted_invoice_url: r.hosted_invoice_url || undefined,
  };
}

export type { InvoiceRow };
