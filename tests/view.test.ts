import { describe, it, expect } from 'vitest';
import { CTC_VIEWS, viewArg, viewResponse } from '../src/view.js';

/** The text a CallToolResult actually carries, for assertions about whitespace. */
const text = (result: ReturnType<typeof viewResponse>): string => {
  const block = result.content?.[0];
  if (!block || block.type !== 'text') throw new Error('expected a text content block');
  return block.text;
};
const parsed = <T>(result: ReturnType<typeof viewResponse>): T => JSON.parse(text(result)) as T;

/**
 * A payload shaped like a Crown Town Compost record that happens to carry
 * media, so the two rungs can be told apart at all. The real
 * `crowntown_get_account` payload has no media in it — see the note on the
 * get_account call-site test.
 */
const withMedia = {
  first_name: 'Test',
  avatar: 'https://portal.crowntowncompost.com/static/avatar.png',
  nested: { name: 'Route 3', image: 'https://portal.crowntowncompost.com/static/truck.jpg' },
  items: [{ label: 'Bin', photo: 'https://portal.crowntowncompost.com/static/bin.png' }],
};

describe('CTC_VIEWS', () => {
  it('honours compact and full only — no raw rung', () => {
    // `raw` means "the upstream payload, unprojected". This server parses HTML
    // into records; there is no upstream JSON to hand back, so advertising the
    // rung would promise something it would have to alias to `full`.
    expect([...CTC_VIEWS]).toEqual(['compact', 'full']);
  });
});

describe('viewArg', () => {
  const schema = viewArg();

  it('is optional, so a caller that names no rung is valid', () => {
    expect(schema.safeParse(undefined).success).toBe(true);
  });

  it('accepts every rung this server honours', () => {
    for (const rung of CTC_VIEWS) expect(schema.safeParse(rung).success).toBe(true);
  });

  it('rejects a rung this server does not honour', () => {
    // The schema is the first line: a value that would silently alias to
    // another rung must not be advertised as accepted.
    expect(schema.safeParse('raw').success).toBe(false);
    expect(schema.safeParse('slim').success).toBe(false);
  });
});

describe('viewResponse', () => {
  it('strips media URLs on the compact rung', () => {
    const data = parsed<typeof withMedia>(viewResponse('compact', withMedia));

    expect(data.first_name).toBe('Test');
    expect(data).not.toHaveProperty('avatar');
    expect(data.nested).not.toHaveProperty('image');
    expect(data.nested.name).toBe('Route 3');
    expect(data.items[0]).not.toHaveProperty('photo');
    expect(data.items[0].label).toBe('Bin');
  });

  it('defaults to compact when the caller names no rung', () => {
    // Efficiency is not something a caller should have to ask for — an
    // undefined `view` must reach the SAME answer as an explicit compact.
    expect(text(viewResponse(undefined, withMedia))).toBe(text(viewResponse('compact', withMedia)));
  });

  it('falls back to compact rather than throwing on a rung it does not honour', () => {
    // resolveView is the second line, and it fails toward the cheap answer.
    expect(text(viewResponse('raw', withMedia))).toBe(text(viewResponse('compact', withMedia)));
  });

  it('keeps media URLs on the full rung', () => {
    const data = parsed<typeof withMedia>(viewResponse('full', withMedia));

    expect(data).toEqual(withMedia);
  });

  it('minifies both rungs — no formatting whitespace', () => {
    for (const rung of CTC_VIEWS) {
      const out = text(viewResponse(rung, withMedia));
      expect(out).not.toContain('\n');
      expect(out).not.toContain(': ');
    }
  });

  it('preserves whitespace INSIDE a value', () => {
    // Minification drops the indent, never the content. A note with a blank
    // line between paragraphs has to survive byte-for-byte.
    const note = 'Leave bin\n\n  by the gate.';
    expect(parsed<{ note: string }>(viewResponse('full', { note })).note).toBe(note);
  });

  it('does not mutate the payload it was handed', () => {
    const original = structuredClone(withMedia);
    viewResponse('compact', withMedia);
    expect(withMedia).toEqual(original);
  });
});
