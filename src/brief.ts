import { UNTRUSTED_CONTENT_RULE, untrustedEnvelope } from '@chrischall/mcp-utils';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { toPortalDate } from './tools/support.js';

/**
 * The `view: 'brief'` rung of the context-groups contract: one line per item,
 * at most 120 chars, `title — <ISO date | no date> — <status>`. A line that
 * starts with `-- ` is a NOTE, not an item: `-- none` for an empty answer,
 * `-- N of M shown` for a partial page.
 */
export const BRIEF_MAX = 120;

/** The portal's human date ("Aug. 7, 2026", "Friday, Jul 31, 2026") as ISO, or "no date". */
export function briefDate(raw: string | undefined): string {
  return (raw && toPortalDate(raw)) || 'no date';
}

/** The shortest a title is cut to before the status gives way too. */
const TITLE_FLOOR = 24;

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, Math.max(n - 1, 0))}…` : s);

/**
 * One brief line, cut to ≤ 120 chars as a WHOLE, title first: the title
 * shortens until the line fits; if the status (portal text on invoices)
 * would still overflow once the title is at its floor, the status is cut too.
 */
export function briefLine(title: string, date: string, status: string): string {
  const sep = ` — ${date} — `;
  const room = BRIEF_MAX - sep.length;
  if (title.length + status.length <= room) return `${title}${sep}${status}`;
  const shownTitle = cut(title, Math.max(room - status.length, Math.min(title.length, TITLE_FLOOR)));
  return `${shownTitle}${sep}${cut(status, room - shownTitle.length)}`;
}

/** `-- none` when there are no items; `-- N of M shown` when the page is partial. */
export function withNotes(lines: string[], total?: number): string[] {
  if (lines.length === 0) return ['-- none'];
  if (total !== undefined && total > lines.length) return [...lines, `-- ${lines.length} of ${total} shown`];
  return lines;
}

/** Bare brief lines: only for lines whose text this server wrote. */
export function briefResponse(lines: string[]): CallToolResult {
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

/**
 * Brief lines carrying third-party text, inside the fleet's untrusted-data
 * envelope as `data: string[]` (minified).
 */
export function untrustedBriefResponse(lines: string[], whoWrote: string): CallToolResult {
  const payload = untrustedEnvelope(lines, { note: `${whoWrote} ${UNTRUSTED_CONTENT_RULE}` });
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}
