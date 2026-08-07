import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TRANSPORT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'transport.ts');

// A STATIC check, deliberately — and the only pre-deploy guard that works for
// this bug.
//
// The trap: workerd requires the global `fetch` to be invoked with a `this` it
// accepts. Storing it on an object (`this.fetchImpl = globalThis.fetch`) and
// calling it detached (`this.fetchImpl(url)`) throws "Illegal invocation" on
// EVERY request in such a runtime. Calling the bare global identifier —
// `fetch(url)`, which is what this transport does — is safe.
//
// Nothing catches it at runtime before a real deploy: Node has no such rule,
// so the whole Node suite passes, and bundling never invokes fetch. Even a
// sandboxed test pool substitutes its own `fetch` wrapper for the global (it
// does not report [native code]), so a detached call resolves normally there
// too — a runtime assertion passes with the bug present. Hence the static
// assertion below.
//
// So this asserts the one property that actually distinguishes the two forms:
// the source calls the bare global. It is a shape assertion rather than a
// behavioural one, which is a real limitation — but a shape assertion that
// fails on the broken form beats a behavioural one that cannot.
describe('FetchTransport global-fetch binding', () => {
  const source = readFileSync(TRANSPORT, 'utf8');

  it('calls the bare global fetch', () => {
    expect(source).toMatch(/\bawait fetch\(/);
  });

  it('never stores globalThis.fetch for a detached call', () => {
    // Catches `= globalThis.fetch`, `fetchImpl = globalThis.fetch`, and the
    // `?? globalThis.fetch` default that produced this bug in the fleet.
    // A wrapped form — `(input, init) => globalThis.fetch(input, init)` — is
    // safe, so only a bare reference (not immediately invoked) is rejected.
    expect(source).not.toMatch(/globalThis\.fetch(?!\s*\()/);
  });
});
