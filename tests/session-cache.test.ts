import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CookieJar } from '@chrischall/mcp-utils';

import {
  sessionCachePath,
  createSessionCache,
  jarFromHeader,
  reportCacheWriteFailure,
} from '../src/session-cache.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ctc-cache-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const on = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  MCP_DATA_DIR: dir,
  CROWNTOWN_USERNAME: 'parent@example.com',
  CROWNTOWN_PASSWORD: 'pw1',
  CROWNTOWN_SESSION_CACHE: 'true',
  ...over,
});

const record = (cookieHeader = 'ASPSESSIONID=abc; member=42') => ({
  session: { cookieHeader },
  sessionAt: Date.now(),
});

const cacheFile = (d: string): string => join(d, '.crowntowncompost-mcp', 'session.json');

describe('jarFromHeader', () => {
  it('round-trips a live jar through its rendered header', () => {
    // The whole design rests on this: the live session holds a CookieJar, which
    // cannot be JSON round-tripped, so the stored form is header() and the jar
    // is rebuilt from it. CookieJar.absorb takes Set-Cookie, where attributes
    // are optional — so bare name=value pairs reproduce the jar.
    const jar = new CookieJar();
    jar.absorb(['ASPSESSIONID=abc123; path=/; HttpOnly', 'member=42; Path=/; Secure']);
    const restored = jarFromHeader(jar.header());
    expect(restored.header()).toBe(jar.header());
    expect(restored.get('member')).toBe('42');
    expect(restored.size).toBe(jar.size);
  });

  it('survives whitespace and a trailing separator', () => {
    const jar = jarFromHeader('  a=1 ;  b=2 ; ');
    expect(jar.get('a')).toBe('1');
    expect(jar.get('b')).toBe('2');
    expect(jar.size).toBe(2);
  });

  it('yields an empty jar for an empty header rather than a bogus cookie', () => {
    expect(jarFromHeader('').size).toBe(0);
  });
});

describe('sessionCachePath', () => {
  it('prefers MCP_DATA_DIR, the variable mcp-host injects', () => {
    expect(sessionCachePath({ MCP_DATA_DIR: '/data' })).toBe('/data/.crowntowncompost-mcp/session.json');
  });

  it('honours an explicit CROWNTOWN_SESSION_FILE', () => {
    expect(sessionCachePath({ CROWNTOWN_SESSION_FILE: '/tmp/x.json', MCP_DATA_DIR: '/data' })).toBe(
      '/tmp/x.json',
    );
  });

  it('ignores a sentinel override rather than making a relative ./null', () => {
    expect(sessionCachePath({ CROWNTOWN_SESSION_FILE: 'null', HOME: '/home/u' })).toBe(
      '/home/u/.crowntowncompost-mcp/session.json',
    );
  });
});

describe('createSessionCache', () => {
  it('round-trips a session through a 0600 file', () => {
    createSessionCache({ env: on() })!.save(record());
    expect(statSync(cacheFile(dir)).mode & 0o777).toBe(0o600);
    expect(createSessionCache({ env: on() })!.load()?.session.cookieHeader).toBe(
      'ASPSESSIONID=abc; member=42',
    );
  });

  it.each([
    ['a rotated password', on({ CROWNTOWN_PASSWORD: 'pw2' })],
    ['a different account', on({ CROWNTOWN_USERNAME: 'other@example.com' })],
  ])('discards the cache on %s', (_label, env) => {
    createSessionCache({ env: on() })!.save(record());
    expect(createSessionCache({ env })!.load()).toBeNull();
  });

  it('matches the username case-insensitively', () => {
    createSessionCache({ env: on() })!.save(record());
    const cased = on({ CROWNTOWN_USERNAME: '  Parent@Example.COM ' });
    expect(createSessionCache({ env: cased })!.load()).not.toBeNull();
  });

  it('writes no credential material to disk', () => {
    createSessionCache({ env: on() })!.save(record());
    const body = readFileSync(cacheFile(dir), 'utf8');
    expect(body).not.toContain('pw1');
    expect(body).not.toContain('parent@example.com');
  });

  it.each([
    ['CROWNTOWN_SESSION_CACHE=false', on({ CROWNTOWN_SESSION_CACHE: 'false' }), {}],
    ['no credentials at all', { MCP_DATA_DIR: dir }, {}],
  ])('is disabled for %s', (_label, env, extra) => {
    expect(createSessionCache({ env, ...extra })).toBeNull();
  });

  it('falls back to the supplied session cookie when there is no login pair', () => {
    // CROWNTOWN_SESSION_COOKIE is a complete configuration on its own, so it is
    // what a record binds to when no username/password is set.
    const cookieOnly = { MCP_DATA_DIR: dir, CROWNTOWN_SESSION_COOKIE: 'sessionid=abc' };
    const p = createSessionCache({ env: cookieOnly });
    expect(p).not.toBeNull();
    p!.save(record());
    expect(createSessionCache({ env: cookieOnly })!.load()).not.toBeNull();
    // Replacing the supplied cookie must discard a record minted from the old one.
    const replaced = { MCP_DATA_DIR: dir, CROWNTOWN_SESSION_COOKIE: 'sessionid=zzz' };
    expect(createSessionCache({ env: replaced })!.load()).toBeNull();
  });

  it('prefers the login pair over a supplied cookie when both are set', () => {
    // Otherwise rotating the password would not discard a record bound only to
    // a cookie that had not changed.
    const both = on({ CROWNTOWN_SESSION_COOKIE: 'sessionid=abc' });
    createSessionCache({ env: both })!.save(record());
    expect(createSessionCache({ env: on({ CROWNTOWN_SESSION_COOKIE: 'sessionid=abc', CROWNTOWN_PASSWORD: 'pw2' }) })!.load()).toBeNull();
  });

  it('writes nothing at all when disabled', () => {
    expect(createSessionCache({ env: on({ CROWNTOWN_SESSION_CACHE: 'false' }) })).toBeNull();
    expect(existsSync(join(dir, '.crowntowncompost-mcp'))).toBe(false);
  });
});

describe('stored-record shape guard', () => {
  it.each([
    ['null', null],
    ['a primitive', 'nope'],
    ['a missing sessionAt', { session: { cookieHeader: 'a=1' } }],
    ['a primitive session', { session: 'nope', sessionAt: 1 }],
    ['a missing cookieHeader', { session: {}, sessionAt: 1 }],
    ['an EMPTY cookieHeader', { session: { cookieHeader: '' }, sessionAt: 1 }],
  ])('rejects %s rather than restoring an unusable session', (_label, body) => {
    // The empty case matters most: an empty jar would look authenticated and
    // then fail every request until the expiry heuristic caught it.
    const p = createSessionCache({ env: on() })!;
    p.save(record());
    // Swap only the STATE, keeping the envelope's salted binding intact —
    // overwriting the whole file would be rejected by the binding check before
    // the shape guard ever ran, which is the wrong reason to pass.
    const envelope = JSON.parse(readFileSync(cacheFile(dir), 'utf8')) as { state: unknown };
    envelope.state = body;
    writeFileSync(cacheFile(dir), JSON.stringify(envelope), { mode: 0o600 });
    expect(createSessionCache({ env: on() })!.load()).toBeNull();
  });
});

describe('reportCacheWriteFailure', () => {
  it.each([
    ['an Error', new Error('EROFS'), 'EROFS'],
    ['a non-Error', 'disk gone', 'disk gone'],
  ])('names the cause for %s and stays on stderr', (_label, thrown, expected) => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      reportCacheWriteFailure(thrown);
      expect(err).toHaveBeenCalledWith(expect.stringContaining(expected as string));
      // stdout is the JSON-RPC channel; a stray write there corrupts the stream.
      expect(out).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
      out.mockRestore();
    }
  });
});
