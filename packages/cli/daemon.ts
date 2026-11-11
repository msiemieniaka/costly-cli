import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { paths, loadConfig, deviceId } from '../core/config';
import { Store } from '../core/store';
import { prices } from '../core/pricing';
import { collect } from '../collector/collect';
import { push } from '../collector/metrics';

interface Lock { pid: number; nonce: string }
export function running(): Lock | undefined {
  try { const lock = JSON.parse(readFileSync(paths().lock, 'utf8')) as Lock; process.kill(lock.pid, 0); return lock; } catch { return; }
}
export async function sync(store: Store) {
  const config = loadConfig();
  return collect(store, config, await prices(paths().home, config.price_file));
}
export async function run() {
  const p = paths();
  const lock: Lock = { pid: process.pid, nonce: crypto.randomUUID() };
  const store = new Store(p.db);
  try {
    // Serialize stale-lock recovery with other costly starts using the store's write lock.
    store.transaction(() => {
      if (running()) throw new Error('Daemon is already running.');
      if (existsSync(p.lock)) unlinkSync(p.lock);
      writeFileSync(p.lock, JSON.stringify(lock), { flag: 'wx', mode: 0o600 });
    }, true);
  } catch (e) { store.close(); throw e; }
  let stopping = false, nextPush = 0, failures = 0, nextPrices = 0, nextScan = 0;
  let table;
  process.on('SIGINT', () => { stopping = true; });
  process.on('SIGTERM', () => { stopping = true; });
  try {
    table = await prices(p.home, loadConfig().price_file, false);
    while (!stopping) {
      if (existsSync(p.stop) && readFileSync(p.stop, 'utf8') === lock.nonce) break;
      const config = loadConfig();
      if (Date.now() >= nextPrices) { table = await prices(p.home, config.price_file); nextPrices = Date.now() + 86400000; }
      // A full scan only stats files and skips unchanged ones, but every second is still wasteful.
      if (Date.now() >= nextScan) { await collect(store, config, table); nextScan = Date.now() + Math.max(1, config.scan_seconds ?? 10) * 1000; }
      if (Date.now() >= nextPush) {
        try {
          const result = await push(store, config, deviceId()); failures = 0;
          store.set('connectionError', !config.endpoint ? 'Not connected; run costly setup.' : result.rejectedSeries ? `Backend refused ${result.rejectedSeries} series; others were sent.` : '');
        }
        catch (e) { failures++; store.set('connectionError', (e as Error).message); }
        nextPush = Date.now() + Math.min(900, Math.max(1, config.interval_seconds || 60) * 2 ** Math.min(failures, 4)) * 1000;
      }
      await Bun.sleep(1000);
    }
  } finally {
    store.close();
    if (existsSync(p.lock) && JSON.parse(readFileSync(p.lock, 'utf8')).nonce === lock.nonce) unlinkSync(p.lock);
    if (existsSync(p.stop) && readFileSync(p.stop, 'utf8') === lock.nonce) unlinkSync(p.stop);
  }
}
export async function start(entry: string) {
  if (running()) return;
  const child = spawn(process.execPath, [entry, 'daemon', 'run'], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
  child.unref();
  for (let i = 0; i < 50; i++) { if (running()) return; await Bun.sleep(100); }
  throw new Error('Daemon did not start; run costly daemon run to diagnose.');
}
export async function stop() {
  const lock = running();
  if (!lock) return;
  writeFileSync(paths().stop, lock.nonce, { mode: 0o600 });
  for (let i = 0; i < 45; i++) { if (!running()) return; await Bun.sleep(1000); }
  throw new Error('Stop requested; daemon is finishing an in-flight operation.');
}
