import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  confirmationFromEnv,
  confirmTokenParam,
  McpToolError,
  minifiedResult,
  requireConfirmationWithFallback,
  toolAnnotations,
} from '@chrischall/mcp-utils';
import { parse } from 'node-html-parser';
import type { CrownTownClient } from '../client.js';
import type { PortalResponse } from '../transport.js';

const MISSED_PICKUP_PATH = '/accounts/report-missed-pickup/';
const SUPPORT_PATH = '/accounts/support/';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAY_PREFIX_RE = /^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+/i;

/**
 * The missed-pickup form's `date` is a text input bound to a bootstrap-datepicker
 * with format 'yyyy-mm-dd' (captured live 2026-09-23), so that is what the portal
 * parses. Accept that directly, or the human form the service calendar shows
 * ("Jul 24, 2026", "Friday, Jul 24, 2026"), and send ISO either way. Returns
 * null for anything that is not an unambiguous calendar date.
 */
export function toPortalDate(input: string): string | null {
  const s = input.trim();
  if (ISO_DATE_RE.test(s)) return s;
  const stripped = s.replace(WEEKDAY_PREFIX_RE, '');
  // Require an explicit year so a bare "Jul 24" is not silently read as 2001.
  if (!/\b\d{4}\b/.test(stripped)) return null;
  const ms = Date.parse(stripped);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Field/form errors Django rendered into a re-displayed form, de-duplicated. */
export function extractFormErrors(html: string): string[] {
  const root = parse(html);
  const texts = root
    .querySelectorAll('ul.errorlist li, .invalid-feedback, .form-control-feedback, .alert-danger')
    .map((el) => el.text.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return [...new Set(texts)];
}

/**
 * Judge a Django form POST sent with redirect:'manual'. A 3xx is Django's
 * post/redirect/get acceptance (form_invalid never redirects). Anything else —
 * in practice a 200 re-render of the form — means the submission was NOT
 * accepted; throw with the field errors so the caller is never told it went
 * through.
 */
function assertFormAccepted(res: PortalResponse, what: string): void {
  if (res.status >= 300 && res.status < 400) return;
  const errors = extractFormErrors(res.body);
  throw new McpToolError(
    errors.length
      ? `The portal did not accept the ${what} — it was NOT submitted: ${errors.join(' ')}`
      : `The portal did not accept the ${what} — it re-displayed the form (HTTP ${res.status}) instead of confirming, so it was NOT submitted.`,
    {
      hint: errors.length
        ? 'Correct the fields named above and retry.'
        : 'The form may have changed shape. Submit it on portal.crowntowncompost.com, or retry later.',
    },
  );
}

/** The value a rendered form pre-fills into input `name`, if any. */
function prefilledValue(html: string, name: string): string | undefined {
  const v = parse(html).querySelector(`input[name="${name}"]`)?.getAttribute('value');
  return v ? v : undefined;
}

export function registerSupportTools(server: McpServer, client: CrownTownClient): void {
  server.registerTool(
    'crowntown_report_missed_pickup',
    {
      title: 'Report a missed pickup',
      description:
        'Report that a scheduled collection was missed. This notifies Crown Town Compost staff. Asks the user to confirm first: a confirmation prompt where the client supports one; otherwise the first call returns a preview and a confirmToken, and only a repeat call with that token proceeds (see MCP_CONFIRM_MODE).',
      annotations: toolAnnotations({ title: 'Report a missed pickup', readOnly: false, openWorld: true, destructive: true }),
      inputSchema: z.object({
        date: z
          .string()
          .min(1)
          .describe('The date of the missed pickup: YYYY-MM-DD, or as shown on your service calendar (e.g. "Jul 24, 2026").'),
        comment: z.string().default('').describe('Optional note with details for the staff.'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ date: rawDate, comment, confirmToken }, ctx) => {
      const date = toPortalDate(rawDate);
      if (date === null) {
        throw new McpToolError(`Could not read "${rawDate}" as a calendar date.`, {
          hint: 'Pass the date as YYYY-MM-DD (e.g. 2026-07-24) or like "Jul 24, 2026", including the year.',
        });
      }
      const wouldSend = { endpoint: MISSED_PICKUP_PATH, date, comment };
      const gate = await requireConfirmationWithFallback(ctx, confirmationFromEnv({
        action: 'support.report_missed_pickup',
        message: 'Review and confirm this missed-pickup report (it notifies Crown Town Compost staff):',
        details: wouldSend,
        tool: 'crowntown_report_missed_pickup',
        confirmToken,
        subject: () => ({
          target: date,
          payload: wouldSend,
          preview: { action: 'report_missed_pickup', wouldSend },
        }),
      }));
      if (gate) return gate;
      const body = new URLSearchParams({ date, comment }).toString();
      const res = await client.submitForm(MISSED_PICKUP_PATH, body);
      assertFormAccepted(res, 'missed-pickup report');
      // Django redirected, so the form validated; there is no per-report re-read to confirm.
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
        'Send a message to Crown Town Compost customer support. The reply-to email and phone default to the ones the support form pre-fills from your account, and the preview shows the exact values that will be sent. Asks the user to confirm first: a confirmation prompt where the client supports one; otherwise the first call returns a preview and a confirmToken, and only a repeat call with that token proceeds (see MCP_CONFIRM_MODE).',
      annotations: toolAnnotations({ title: 'Contact support', readOnly: false, openWorld: true, destructive: true }),
      inputSchema: z.object({
        message: z.string().min(1).describe('The message to send to support.'),
        email: z.string().email().optional().describe('Reply-to email (defaults to the account email if omitted).'),
        phone: z.string().optional().describe('Contact phone (optional).'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ message, email, phone, confirmToken }, ctx) => {
      // The form pre-fills email and phone from the account and a browser submits
      // them; read it first so an omitted field carries that value, not nothing.
      // Read on every call, so the preview (and the token) name the real values.
      const form = await client.fetchHtml(SUPPORT_PATH);
      const params = new URLSearchParams({ message });
      const replyEmail = email ?? prefilledValue(form, 'email');
      const replyPhone = phone ?? prefilledValue(form, 'phone');
      if (replyEmail) params.set('email', replyEmail);
      if (replyPhone) params.set('phone', replyPhone);
      const wouldSend = {
        endpoint: SUPPORT_PATH,
        message,
        email: replyEmail ?? '(not set)',
        phone: replyPhone ?? '(not set)',
      };
      const gate = await requireConfirmationWithFallback(ctx, confirmationFromEnv({
        action: 'support.contact',
        message: 'Review and confirm this message to Crown Town Compost support:',
        details: wouldSend,
        tool: 'crowntown_contact_support',
        confirmToken,
        subject: () => ({
          target: SUPPORT_PATH,
          payload: { endpoint: SUPPORT_PATH, body: params.toString() },
          preview: { action: 'contact_support', wouldSend },
        }),
      }));
      if (gate) return gate;
      const res = await client.submitForm(SUPPORT_PATH, params.toString());
      assertFormAccepted(res, 'support message');
      return minifiedResult({
        submitted: true,
        verified: false,
        status: res.status,
        note: 'The portal accepted your support message, but this server cannot confirm it was delivered. Expect a reply by email.',
      });
    },
  );
}
