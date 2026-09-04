import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { CrownTownClient } from '../client.js';

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
        'List your Crown Town Compost invoices — number, date, amount, status, whether payable, and links (Stripe PDF / receipt / hosted invoice page). Paginated. Read-only.',
      annotations: toolAnnotations({ title: 'List invoices', readOnly: true, idempotent: true, openWorld: true }),
      inputSchema: {
        page: z.number().int().positive().default(1).describe('1-based page number.'),
        per_page: z.number().int().positive().max(100).default(20).describe('Rows per page (max 100).'),
        payable_only: z.boolean().default(false).describe('Return only open/payable invoices.'),
      },
    },
    async ({ page, per_page, payable_only }) => {
      const res = await client.datatable<InvoiceRow>('/accounts/billing-history/api/', {
        page,
        perpage: per_page,
        sortField: 'date',
        sortDir: 'desc',
      });
      let invoices = (res.data ?? []).map((r) => ({
        id: r.RecordID,
        number: r.number,
        date: r.date,
        amount: r.amount,
        status: r.status,
        is_payable: r.is_payable,
        invoice_pdf: r.invoice_pdf || undefined,
        receipt_url: r.receipt_url || undefined,
        hosted_invoice_url: r.hosted_invoice_url || undefined,
      }));
      if (payable_only) invoices = invoices.filter((i) => i.is_payable);
      return minifiedResult({
        page: res.meta?.page,
        pages: res.meta?.pages,
        per_page: res.meta?.perpage,
        total: res.meta?.total,
        note: 'To pay an open invoice, open its hosted_invoice_url in a browser — this server does not process payments.',
        invoices,
      });
    },
  );
}

export type { InvoiceRow };
