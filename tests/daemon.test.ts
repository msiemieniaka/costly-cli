import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
test('non-interactive background start, second start, status and graceful stop', async () => {
  const root = mkdtempSync(join(tmpdir(), 'costly-daemon-'));
  const entry = resolve('packages/cli/main.ts');
  const call = async (...args: string[]) => {
    const p = Bun.spawn([process.execPath, entry, ...args], { env: { ...process.env, COSTLY_HOME: root }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (code) throw new Error(stderr);
    return stdout;
  };
  try {
    writeFileSync(join(root, 'config.toml'), `user="dev@example.invalid"\nclaude_dir=${JSON.stringify(join(root, 'absent-claude'))}\ncodex_dir=${JSON.stringify(join(root, 'absent-codex'))}\n`);
    writeFileSync(join(root, 'prices.json'), JSON.stringify({ version: 'synthetic', models: {} }));
    expect(await call('daemon', 'start')).toContain('Daemon started');
    expect(existsSync(join(root, 'daemon.lock'))).toBe(true);
    expect(await call('daemon', 'start')).toContain('Daemon already running');
    expect(JSON.parse(await call('status')).running).toBe(true);
    expect(await call('daemon', 'stop')).toContain('Daemon stopped');
    expect(JSON.parse(await call('status')).running).toBe(false);
  } finally {
    if (existsSync(join(root, 'daemon.lock'))) await call('daemon', 'stop');
    rmSync(root, { recursive: true });
  }
}, 30000);
