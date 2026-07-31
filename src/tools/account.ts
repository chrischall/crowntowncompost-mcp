import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { textResult, toolAnnotations, schemaConfirm } from '@chrischall/mcp-utils';
import type { CrownTownClient } from '../client.js';
import { parseDashboard, parseImpact, parseAccountDetails, type AccountDetails } from '../parse.js';

const UPDATE_PATH = '/accounts/update/';

/** Build the update form body from current values overlaid with the requested changes. */
export function buildUpdateBody(current: AccountDetails, changes: Partial<AccountDetails>): { body: string; next: AccountDetails } {
  const next: AccountDetails = { ...current, ...changes };
  const params = new URLSearchParams();
  params.set('first_name', next.first_name);
  params.set('last_name', next.last_name);
  params.set('phone', next.phone);
  // Django BooleanField checkboxes carry no value attribute, so they submit "on"
  // when checked and are simply omitted when unchecked (the browser's behaviour).
  if (next.send_email_reminders) params.set('send_email_reminders', 'on');
  if (next.service_notifications) params.set('service_notifications', 'on');
  return { body: params.toString(), next };
}

export function registerAccountTools(server: McpServer, client: CrownTownClient): void {
  server.registerTool(
    'crowntown_get_dashboard',
    {
      title: 'Get account dashboard summary',
      description:
        'Get your Crown Town Compost dashboard: account status, active subscription (plan, price, renewal date), next service date, service address(es) and their pickup day(s), and your composting environmental impact (lbs diverted, seedlings, miles offset, gallons of gas). Read-only.',
      annotations: toolAnnotations({ title: 'Get dashboard summary', readOnly: true, idempotent: true, openWorld: true }),
      inputSchema: {},
    },
    async () => {
      const dash = parseDashboard(await client.fetchHtml('/accounts/'));
      // Environmental-impact numbers load from a separate htmx fragment.
      let impact = null;
      try {
        impact = parseImpact(await client.fetchHtml('/accounts/impact-statistics/'));
      } catch {
        /* impact is a nice-to-have; the dashboard is still useful without it */
      }
      return textResult({ ...dash, environmental_impact: impact });
    },
  );

  server.registerTool(
    'crowntown_get_account',
    {
      title: 'Get account contact details',
      description:
        'Get your account contact details (first name, last name, phone) and notification preferences (email reminders, service notifications). Read-only — use crowntown_update_account to change them.',
      annotations: toolAnnotations({ title: 'Get account details', readOnly: true, idempotent: true, openWorld: true }),
      inputSchema: {},
    },
    async () => {
      const details = parseAccountDetails(await client.fetchHtml(UPDATE_PATH));
      return textResult(details);
    },
  );

  server.registerTool(
    'crowntown_update_account',
    {
      title: 'Update account contact details / preferences',
      description:
        'Update your contact details and/or notification preferences. Reads your current account form, changes ONLY the field(s) you specify, and re-saves the rest verbatim. Without confirm:true this is a DRY RUN showing the resulting state.',
      annotations: toolAnnotations({ title: 'Update account details', readOnly: false, openWorld: true }),
      inputSchema: {
        first_name: z.string().min(1).optional().describe('New first name.'),
        last_name: z.string().min(1).optional().describe('New last name.'),
        phone: z.string().min(1).optional().describe('New phone number.'),
        send_email_reminders: z.boolean().optional().describe('Toggle email pickup reminders.'),
        service_notifications: z.boolean().optional().describe('Toggle service notifications.'),
        confirm: schemaConfirm,
      },
    },
    async ({ confirm, ...changes }) => {
      const provided = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)) as Partial<AccountDetails>;
      if (Object.keys(provided).length === 0) {
        return textResult({ error: 'Specify at least one field to change (first_name, last_name, phone, send_email_reminders, service_notifications).' });
      }
      const current = parseAccountDetails(await client.fetchHtml(UPDATE_PATH));
      const { body, next } = buildUpdateBody(current, provided);
      if (confirm !== true) {
        return textResult({
          preview: true,
          action: 'update_account',
          note: 'DRY RUN — nothing was sent. Re-run with confirm: true to save.',
          current,
          wouldSet: next,
        });
      }
      const res = await client.write(UPDATE_PATH, body);
      // Django 302s on save; re-read to confirm the values actually persisted.
      const after = parseAccountDetails(await client.fetchHtml(UPDATE_PATH));
      const verified =
        after.first_name === next.first_name &&
        after.last_name === next.last_name &&
        after.phone === next.phone &&
        after.send_email_reminders === next.send_email_reminders &&
        after.service_notifications === next.service_notifications;
      return textResult({
        updated: verified,
        verified,
        status: res.status,
        account: after,
        ...(verified ? {} : { note: 'The portal accepted the request but a re-read shows the values did not fully change — the save may not have persisted.' }),
      });
    },
  );
}
