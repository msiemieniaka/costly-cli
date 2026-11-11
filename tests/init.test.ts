import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { markerText, ruleText, validateLabel } from '../packages/cli/init';
const entry = resolve('packages/cli/main.ts');
test('surgical TOML updates preserve comments, unrelated keys and tables', () => {
  const original = '# hello\nuser = "dev@example.invalid"\n[[rule]] # keep\nmatch_remote = "github.com/acme/repo"\nproject = "old" # label\nextra = "keep"\n[[rule]]\nmatch_path = "/other"\nproject = "other"\n[custom]\nvalue = 42\n';
  const target = { root: '/repo', remote: 'github.com/acme/repo', branch: '' };
  const changed = ruleText(original, target, { project: 'new', team: 'core' });
  expect(changed).toContain('project = "new" # label');
  expect(changed).toContain('extra = "keep"');
  expect(changed).toContain('[custom]\nvalue = 42');
  expect(ruleText(changed, target, { project: 'new', team: 'core' })).toBe(changed);
  expect(ruleText(original.replace(/\n/g, '\r\n'), target, { project: 'new' })).toContain('project = "new" # label\r\n');
  expect(markerText('# marker\nproject = "old" # note\ncustom = 1\n[table]\nx = 2\n', { project: 'new' })).toContain('custom = 1\n[table]');
  expect(() => markerText('project = """old\nname"""\n', { project: 'new' })).toThrow();
});
test('label validation', () => {
  for (const name of ['', 'a b', 'x/y', 'x'.repeat(64), 'x\ny']) expect(() => validateLabel(name)).toThrow();
  expect(validateLabel('Acme.api_1-2')).toBe('Acme.api_1-2');
});
test('init CLI: root discovery, non-TTY, modes, preservation, attribution and doctor', () => {
  const temp = mkdtempSync(join(tmpdir(), 'costly init '));
  const home = join(temp, 'home'), repo = join(temp, 'repo'), child = join(repo, 'child');
  mkdirSync(child, { recursive: true }); mkdirSync(home);
  const env = { ...process.env, COSTLY_HOME: home, COSTLY_PROJECT: '', COSTLY_COMPONENT: '' };
  const cli = (args: string[], cwd = child) => {
    const p = Bun.spawnSync([process.execPath, entry, ...args], { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  const git = (...args: string[]) => { expect(Bun.spawnSync(['git', ...args], { cwd: repo }).exitCode).toBe(0); };
  try {
    git('init'); git('remote', 'add', 'origin', 'git@github.com:acme/repo.git');
    expect(cli(['init']).err).toContain('--project');
    expect(existsSync(join(repo, '.costly.toml'))).toBe(false);
    expect(cli(['init', '--project', 'bad name']).code).toBe(1);
    expect(cli(['init', '--project', 'acme', '--component', 'api', '--team', 'core']).code).toBe(0);
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toContain('github.com/acme/repo');
    expect(existsSync(join(child, '.costly.toml'))).toBe(false);
    expect(JSON.parse(cli(['project']).out).project).toBe('acme');
    expect(cli(['init', '--project', 'new', '--yes']).code).toBe(1);
    expect(cli(['init', '--project', 'new', '--force']).code).toBe(0);
    expect((Bun.TOML.parse(readFileSync(join(home, 'config.toml'), 'utf8')) as any).rule).toHaveLength(1);
    expect(cli(['init', '--project', 'local', '--local']).code).toBe(0);
    expect(cli(['doctor']).out).toContain('Marker and local rule disagree');
    const config = readFileSync(join(home, 'config.toml'), 'utf8');
    expect(cli(['init', '--project', 'repo', '--repo-only', '--force']).code).toBe(0);
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(config);
    expect(cli(['init', '--project', 'x', '--local', '--repo-only']).code).toBe(1);
    git('remote', 'remove', 'origin');
    expect(cli(['init', '--project', 'path', '--force']).code).toBe(0);
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toContain(repo.replace(/\\/g, '/'));
    const plain = join(temp, 'all repos'); mkdirSync(plain);
    expect(cli(['init', '--project', 'parent'], plain).code).toBe(0);
    expect(existsSync(join(plain, '.costly.toml'))).toBe(true);
    expect(cli(['help']).out).not.toContain('daemon');
    expect(cli(['stop']).code).toBe(0);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('failed marker write leaves existing or absent config untouched', () => {
  const temp = mkdtempSync(join(tmpdir(), 'costly-readonly-'));
  const repo = join(temp, 'repo'), home = join(temp, 'home');
  mkdirSync(repo); mkdirSync(home);
  const marker = join(repo, '.costly.toml'), config = join(home, 'config.toml');
  const original = 'project = "old" # keep\n';
  try {
    writeFileSync(marker, original);
    chmodSync(marker, 0o444);
    for (const existing of [false, true]) {
      const configText = '# keep this config\nuser = "dev@example.invalid"\n';
      if (existing) writeFileSync(config, configText);
      const result = Bun.spawnSync([process.execPath, entry, 'init', '--project', 'p', '--force'], {
        cwd: repo, env: { ...process.env, COSTLY_HOME: home }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      });
      expect(result.exitCode).toBe(1);
      expect(readFileSync(marker, 'utf8')).toBe(original);
      expect(existing ? readFileSync(config, 'utf8') : existsSync(config)).toBe(existing ? configText : false);
      expect(result.stdout.toString()).not.toContain('Rule saved');
      expect(result.stderr.toString()).toContain('Cannot write project marker');
      expect(result.stderr.toString()).toContain('config.toml was not changed');
    }
  } finally {
    chmodSync(marker, 0o644);
    rmSync(temp, { recursive: true, force: true });
  }
});
