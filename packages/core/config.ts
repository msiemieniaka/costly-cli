import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Config } from './types';

export function paths() {
  const home = process.env.COSTLY_HOME || join(homedir(), '.config', 'costly');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return { home, config: join(home, 'config.toml'), db: join(home, 'usage.sqlite'), device: join(home, 'device-id'), lock: join(home, 'daemon.lock'), stop: join(home, 'stop') };
}
const connectionKeys = ['endpoint', 'secret_ref', 'instance_id', 'auth', 'history_mode', 'user'] as const;
/** Only the fields `costly setup` owns. Everything else lives in config.toml, which the user edits. */
export function loadConnection(): Partial<Config> {
  const path = join(paths().home, 'connection.json');
  const raw = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Partial<Config> : {};
  return Object.fromEntries(connectionKeys.filter(k => raw[k] !== undefined).map(k => [k, raw[k]]));
}
export function loadConfig(): Config {
  const p = paths();
  const base = existsSync(p.config) ? Bun.TOML.parse(readFileSync(p.config, 'utf8')) as Config : {};
  const config = { ...base, ...loadConnection() } as Config;
  if (config.backfill_days !== undefined && (!Number.isFinite(config.backfill_days) || config.backfill_days <= 0)) throw new Error('backfill_days must be positive.');
  if (config.interval_seconds !== undefined && (!Number.isFinite(config.interval_seconds) || config.interval_seconds <= 0)) throw new Error('interval_seconds must be positive.');
  return config;
}
export function saveConnection(config: Partial<Config>) {
  const connection = Object.fromEntries(connectionKeys.filter(k => config[k] !== undefined).map(k => [k, config[k]]));
  writeFileSync(join(paths().home, 'connection.json'), JSON.stringify(connection, null, 2), { mode: 0o600 });
}
export function deviceId(): string {
  const path = paths().device;
  if (!existsSync(path)) {
    try { writeFileSync(path, crypto.randomUUID(), { flag: 'wx', mode: 0o600 }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  }
  return readFileSync(path, 'utf8').trim();
}
export function validateEndpoint(value: string) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error('Use keychain authentication, not credentials or query strings in the URL.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Remote endpoints require HTTPS.');
  return value.replace(/\/$/, '').replace(/\/v1\/metrics$/, '') + '/v1/metrics';
}
