import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { homedir, hostname, userInfo } from 'node:os';
import { createHash, createHmac } from 'node:crypto';
import type { Config, Provider } from './types';

export function command(args: string[], cwd?: string): string {
  try { const r = Bun.spawnSync(args, { cwd: cwd || undefined, stdout: 'pipe', stderr: 'ignore', timeout: 3000 }); return r.exitCode === 0 ? r.stdout.toString().trim() : ''; } catch { return ''; }
}
export function normalizeRemote(remote: string) {
  return remote.replace(/^git@([^:]+):/, '$1/').replace(/^https?:\/\/(?:[^@/]+@)?/, '').replace(/^ssh:\/\/git@/, '').replace(/\.git\/?$/, '').replace(/\/$/, '');
}
function matches(value: string, pattern: string) {
  const escaped = pattern.replace(/^~/, homedir()).replace(/\\/g, '/').split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp('^' + escaped + '$', process.platform === 'win32' ? 'i' : '').test(value.replace(/\\/g, '/'));
}
export function project(cwd: string, config: Config, env = process.env, saved?: { remote: string; branch: string; component: string }) {
  const root = cwd && command(['git', 'rev-parse', '--show-toplevel'], cwd);
  const remote = root ? normalizeRemote(command(['git', 'remote', 'get-url', 'upstream'], cwd) || command(['git', 'remote', 'get-url', 'origin'], cwd)) : saved?.remote || '';
  const branch = root ? command(['git', 'branch', '--show-current'], cwd) : saved?.branch || '';
  const component = remote.split('/').pop() || (root ? basename(root) : saved?.component || 'unassigned');
  let selected = { project: component, component, team: config.team || '', source: root ? 'git' : 'unassigned' };
  const rule = config.rule?.find(r => (r.match_path || r.match_remote || r.match_branch) && (!r.match_path || matches(cwd, r.match_path)) && (!r.match_remote || matches(remote, r.match_remote)) && (!r.match_branch || matches(branch, r.match_branch)));
  if (rule) selected = { ...selected, ...rule, source: 'rule' };
  if (cwd && existsSync(cwd)) for (let dir = resolve(cwd);; dir = dirname(dir)) {
    let marker: Record<string, string> | undefined;
    const toml = dir + '/.costly.toml';
    if (existsSync(toml)) { try { marker = Bun.TOML.parse(readFileSync(toml, 'utf8')) as Record<string, string>; } catch { /* malformed marker is ignored */ } }
    if (!marker) for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const path = dir + '/' + name;
      if (!existsSync(path)) continue;
      const match = readFileSync(path, 'utf8').match(/<!--\s*costly:\s*([^\n]*?)-->/);
      if (match) { marker = Object.fromEntries([...match[1].matchAll(/(project|component|team)=([^\s]+)/g)].map(m => [m[1], m[2]])); break; }
    }
    if (marker?.project) { selected = { ...selected, project: marker.project, component: marker.component || component, team: marker.team || config.team || '', source: 'marker' }; break; }
    if (dirname(dir) === dir) break;
  }
  if (env.COSTLY_PROJECT) selected = { ...selected, project: env.COSTLY_PROJECT, source: 'environment' };
  if (env.COSTLY_COMPONENT) selected.component = env.COSTLY_COMPONENT;
  return { ...selected, remote, branch };
}
export function identity(config: Config, provider: Provider, cwd = '', run = command, toolEmail = '', env = process.env) {
  const candidates: [string | undefined, string][] = [[env.COSTLY_USER || config.user, 'config']];
  if (!candidates[0][0] && provider === 'bedrock') {
    const args = ['aws', 'sts', 'get-caller-identity', '--output', 'json'];
    if (env.AWS_PROFILE) args.push('--profile', env.AWS_PROFILE);
    try {
      const arn = JSON.parse(run(args)).Arn as string;
      const session = arn.split('/').pop() || '';
      candidates.push([session.includes('@') ? session : config.email_template?.replace('{session_name}', session), 'aws']);
    } catch { /* optional cloud CLI / credentials unavailable */ }
  }
  if (!candidates[0][0] && provider === 'vertex') candidates.push([run(['gcloud', 'config', 'get-value', 'account']), 'gcp']);
  candidates.push([toolEmail, 'tool'], [run(['git', 'config', 'user.email'], cwd), 'git']);
  for (const [raw, source] of candidates) {
    if (!raw) continue;
    let user = raw.trim().toLowerCase();
    user = config.user_alias?.find(a => a.from.toLowerCase() === user)?.to.toLowerCase() || user;
    if (!/^[^\s@]+@[^\s@]+$/.test(user)) continue;
    if (config.allowed_email_domains?.length && !config.allowed_email_domains.includes(user.split('@')[1])) continue;
    return { user: config.user_mode === 'hash' ? hashUser(user, config, env) : user, source };
  }
  const user = `unknown:${userInfo().username}@${hostname()}`;
  return { user: config.user_mode === 'hash' ? hashUser(user, config, env) : user, source: 'os' };
}
/**
 * Pseudonymous, not anonymous. Without a team secret, anyone can reverse a plain hash by hashing
 * candidate emails, so set COSTLY_USER_HASH_KEY (same value on every team machine) for an HMAC.
 */
export function hashUser(user: string, config: Config, env = process.env) {
  const key = env.COSTLY_USER_HASH_KEY || config.user_hash_key;
  return key ? createHmac('sha256', key).update(user).digest('hex') : createHash('sha256').update(user).digest('hex');
}
