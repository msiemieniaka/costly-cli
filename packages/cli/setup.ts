import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { loadConfig, loadConnection, saveConnection, validateEndpoint, deviceId } from '../core/config';
import { post, payload, authHeaders } from '../collector/metrics';
import { identity } from '../core/attribution';
import type { Config } from '../core/types';

export function repoRoot() {
  for (const path of [resolve(import.meta.dir, '../..'), resolve(import.meta.dir, '../../..'), process.cwd()]) if (existsSync(join(path, 'docker', 'compose.yml'))) return path;
  throw new Error('Docker assets not found; run from the costly source checkout.');
}
export async function stack(action: string) {
  if (!['up', 'down'].includes(action)) throw new Error('Use costly stack up|down.');
  const args = ['docker', 'compose', '-f', join(repoRoot(), 'docker', 'compose.yml'), action];
  if (action === 'up') args.push('-d', '--wait', '--wait-timeout', '120');
  let child;
  try { child = Bun.spawn(args, { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }); } catch { throw new Error('Docker is unavailable. Start Docker Desktop and retry.'); }
  if (await child.exited !== 0) throw new Error('Docker stack failed. Check that Docker Desktop is running and ports are free.');
}
export async function setup(options: Record<string, string | boolean>) {
  // Setup edits only the connection fields; rules, user, domains etc. stay in config.toml.
  const config: Partial<Config> = loadConnection();
  const scripted = typeof options.endpoint === 'string';
  if (!scripted && !process.stdin.isTTY) throw new Error('Non-interactive setup needs --endpoint.');
  if (!scripted) {
    const io = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const who = identity(loadConfig(), 'unknown', process.cwd());
      const email = await io.question(`Identity: ${who.user} (${who.source}). Enter to keep, or type email: `);
      if (email.trim()) config.user = email.trim();
      const choice = await io.question('1) Grafana Cloud\n2) Own OTLP endpoint\n3) Local Docker Grafana\n4) Not now\n> ');
      if (choice === '4' || !choice) { saveConnection(config); console.log('Collecting locally. Connect later with costly setup.'); return; }
      if (choice === '3') { await stack('up'); config.endpoint = 'http://127.0.0.1:4318'; config.secret_ref = undefined; config.auth = undefined; config.history_mode = 'event'; }
      else if (choice === '1' || choice === '2') {
        config.endpoint = (await io.question('OTLP HTTP base URL: ')).trim();
        if (choice === '1') { config.auth = 'basic'; config.instance_id = (await io.question('Grafana instance ID: ')).trim(); config.history_mode = 'now'; console.log('Past usage appears as one total; daily charts start today. Full history: costly report.'); }
        const variable = (await io.question('Environment variable holding token (blank for no auth): ')).trim();
        if (variable) options['token-env'] = variable;
      } else throw new Error('Choose 1, 2, 3 or 4.');
    } finally { io.close(); }
  } else config.endpoint = String(options.endpoint);
  if (options['instance-id']) { config.instance_id = String(options['instance-id']); config.auth = 'basic'; config.history_mode = 'now'; }
  config.endpoint = validateEndpoint(config.endpoint!);
  if (options['token-env']) {
    const token = process.env[String(options['token-env'])];
    if (!token) throw new Error('Token environment variable is empty.');
    config.secret_ref = crypto.randomUUID(); config.auth ||= 'bearer';
    await Bun.secrets.set({ service: 'costly', name: config.secret_ref, value: token, persist: 'local' });
  }
  const now = (BigInt(Date.now()) * 1000000n).toString();
  try {
    await post(config, payload({ key: 'connection-test', name: 'costly_connection_test', points: [{ timeUnixNano: now, startTimeUnixNano: now, asDouble: 1, attributes: [] }] }, deviceId()), await authHeaders(config));
  } catch (e) {
    if (options['token-env'] && config.secret_ref) await Bun.secrets.delete({ service: 'costly', name: config.secret_ref });
    throw e;
  }
  saveConnection(config);
  console.log('Connection test accepted. Dashboard: ' + join(repoRoot(), 'docker', 'grafana', 'dashboards', 'costly.json'));
  console.log('Local Docker provisions it automatically; otherwise import this JSON in Grafana.');
}
