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
    expect(await call('stop')).toContain('Daemon is not running.');
    writeFileSync(join(root, 'config.toml'), `user="dev@example.invalid"\nclaude_dir=${JSON.stringify(join(root, 'absent-claude'))}\ncodex_dir=${JSON.stringify(join(root, 'absent-codex'))}\n`);
    writeFileSync(join(root, 'prices.json'), JSON.stringify({ version: 'synthetic', models: {} }));
    const help = await call('help');
    expect(help).not.toMatch(/\brun\b/);
    expect(help).not.toContain('__collector');
    expect(help).not.toContain('daemon');
    for (const args of [['run'], ['daemon'], ['daemon', 'run'], ['daemon', 'start'], ['daemon', 'stop'], ['daemon', 'status']]) {
      const result = Bun.spawnSync([process.execPath, entry, ...args], {
        env: { ...process.env, COSTLY_HOME: root }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 3000,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString().trim()).toBe('Unknown command; use costly help.');
      expect(result.stdout.toString()).toBe('');
      expect(existsSync(join(root, 'daemon.lock'))).toBe(false);
    }
    expect(await call('start')).toContain('Daemon started');
    expect(existsSync(join(root, 'daemon.lock'))).toBe(true);
    expect(await call('start')).toContain('Daemon already running');
    expect(JSON.parse(await call('status')).running).toBe(true);
    const duplicate = Bun.spawnSync([process.execPath, entry, '__collector'], {
      env: { ...process.env, COSTLY_HOME: root }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 3000,
    });
    expect(duplicate.exitCode).toBe(1);
    expect(duplicate.stdout.toString()).toBe('');
    expect(duplicate.stderr.toString()).toBe('');
    expect(await call('stop')).toContain('Daemon stopped');
    expect(JSON.parse(await call('status')).running).toBe(false);
    expect(await call('stop')).toContain('Daemon is not running.');
  } finally {
    if (existsSync(join(root, 'daemon.lock'))) await call('stop');
    rmSync(root, { recursive: true });
  }
}, 30000);
