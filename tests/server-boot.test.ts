import { describe, it, expect, beforeAll } from 'vitest';
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

// End-to-end boot guard: spawn the REAL built artifacts and confirm they answer
// initialize + tools/list — exactly what an MCP host does at install time. This
// catches an eager import of a dep that isn't in the bundle, and a `bin` path
// tsc never emitted; unit tests (which mock everything) never see either.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = join(ROOT, 'dist', 'bundle.js');
const BIN = join(ROOT, 'dist', 'index.js');

beforeAll(() => {
  if (!existsSync(BUNDLE) || !existsSync(BIN)) {
    execSync('npm run build', { cwd: ROOT, stdio: 'ignore' });
  }
}, 120_000);

/** Spawn an MCP stdio server, run the initialize + tools/list handshake, return tool names. */
function listToolsViaStdio(entry: string, cwd: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [entry], {
      cwd,
      // No creds: the server must still boot and serve tools/list (deferred-config).
      env: { ...process.env, CROWNTOWN_USERNAME: '', CROWNTOWN_PASSWORD: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out; stderr:\n${err}`));
    }, 15_000);

    child.stdout.on('data', (d) => {
      out += d.toString();
      for (const line of out.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        let msg: { id?: number; result?: { tools?: { name: string }[] } };
        try { msg = JSON.parse(t); } catch { continue; }
        if (msg.id === 1 && msg.result) {
          clearTimeout(timer);
          child.kill('SIGKILL');
          resolve((msg.result.tools ?? []).map((x) => x.name));
          return;
        }
      }
    });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    // 'close' (not 'exit') so stdout drains first — avoids a flaky false failure.
    child.on('close', (code) => {
      if (out.indexOf('"id":1') === -1) {
        clearTimeout(timer);
        reject(new Error(`server exited (code ${code}) before tools/list; stderr:\n${err}`));
      }
    });

    child.stdin.write('{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"boot-test","version":"1"}}}\n');
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
  });
}

// Lower bound, not an exact count: the PR is CI-tested merged with main, so a
// hardcoded count would break the moment another branch adds a tool.
// index.test.ts owns the exact roster.
const MIN_TOOLS = 10;

describe('server boot (built artifacts)', () => {
  it('bundled .mcpb (dist/bundle.js) boots WITHOUT node_modules and lists its tools', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crowntown-mcpb-'));
    try {
      copyFileSync(BUNDLE, join(dir, 'bundle.js'));
      const tools = await listToolsViaStdio(join(dir, 'bundle.js'), dir);
      expect(tools.length).toBeGreaterThanOrEqual(MIN_TOOLS);
      expect(tools).toContain('crowntown_healthcheck');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('npm bin (dist/index.js) boots with node_modules and lists its tools', async () => {
    const tools = await listToolsViaStdio(BIN, ROOT);
    expect(tools.length).toBeGreaterThanOrEqual(MIN_TOOLS);
    expect(tools).toContain('crowntown_healthcheck');
  }, 30_000);
});
