import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { minifiedResult, schemaConfirm, toolAnnotations } from '@chrischall/mcp-utils';
import type { CrownTownClient } from '../client.js';

const MISSED_PICKUP_PATH = '/accounts/report-missed-pickup/';
const SUPPORT_PATH = '/accounts/support/';

export function registerSupportTools(server: McpServer, client: CrownTownClient): void {
  server.registerTool(
    'crowntown_report_missed_pickup',
    {
      title: 'Report a missed pickup',
      description:
        'Report that a scheduled collection was missed. This notifies Crown Town Compost staff. Without confirm:true this is a DRY RUN that returns a preview and makes no network call.',
      annotations: toolAnnotations({ title: 'Report a missed pickup', readOnly: false, openWorld: true }),
      inputSchema: {
        date: z.string().min(1).describe('The date of the missed pickup (as shown on your service calendar, e.g. "Jul 24, 2026").'),
        comment: z.string().default('').describe('Optional note with details for the staff.'),
        confirm: schemaConfirm,
      },
    },
    async ({ date, comment, confirm }) => {
      if (confirm !== true) {
        return minifiedResult({
          preview: true,
          action: 'report_missed_pickup',
          note: 'DRY RUN — nothing was sent. Re-run with confirm: true to submit the report (this notifies staff).',
          wouldSend: { endpoint: MISSED_PICKUP_PATH, date, comment },
        });
      }
      const body = new URLSearchParams({ date, comment }).toString();
      const res = await client.write(MISSED_PICKUP_PATH, body);
      // The portal 302s on submit; there is no per-report re-read to confirm.
      return minifiedResult({
        submitted: true,
        verified: false,
        status: res.status,
        note: 'The portal accepted the missed-pickup report (staff are notified), but this server cannot confirm it was recorded. Follow up via support if unresolved.',
        date,
      });
    },
  );

  server.registerTool(
    'crowntown_contact_support',
    {
      title: 'Send a message to customer support',
      description:
        'Send a message to Crown Town Compost customer support. Without confirm:true this is a DRY RUN that returns a preview and makes no network call.',
      annotations: toolAnnotations({ title: 'Contact support', readOnly: false, openWorld: true }),
      inputSchema: {
        message: z.string().min(1).describe('The message to send to support.'),
        email: z.string().email().optional().describe('Reply-to email (defaults to the account email if omitted).'),
        phone: z.string().optional().describe('Contact phone (optional).'),
        confirm: schemaConfirm,
      },
    },
    async ({ message, email, phone, confirm }) => {
      const params = new URLSearchParams({ message });
      if (email) params.set('email', email);
      if (phone) params.set('phone', phone);
      if (confirm !== true) {
        return minifiedResult({
          preview: true,
          action: 'contact_support',
          note: 'DRY RUN — nothing was sent. Re-run with confirm: true to send this message to support.',
          wouldSend: { endpoint: SUPPORT_PATH, ...Object.fromEntries(params) },
        });
      }
      const res = await client.write(SUPPORT_PATH, params.toString());
      return minifiedResult({
        submitted: true,
        verified: false,
        status: res.status,
        note: 'The portal accepted your support message, but this server cannot confirm it was delivered. Expect a reply by email.',
      });
    },
  );
}
