import { createHash } from 'node:crypto';
import { tokenTypes, type RecordUsage, type Config } from '../core/types';
import { validateEndpoint } from '../core/config';
import { Store } from '../core/store';

export interface Point { timeUnixNano: string; startTimeUnixNano: string; asDouble: number; attributes: { key: string; value: { stringValue: string } }[] }
export interface Series { name: string; key: string; points: Point[] }
const nano = (ms: number) => (BigInt(ms) * 1000000n).toString();
const attrs = (labels: Record<string, string>) => Object.entries(labels).map(([key, stringValue]) => ({ key, value: { stringValue } }));

export function series(rows: RecordUsage[], now = Date.now(), days = 30): Series[] {
  const closedBefore = Math.floor(now / 60000) * 60000;
  const groups = new Map<string, { name: string; labels: Record<string, string>; buckets: Map<number, number> }>();
  const sessions = new Set<string>();
  function add(name: string, labels: Record<string, string>, time: number, value: number) {
    const key = JSON.stringify([name, labels]);
    let g = groups.get(key);
    if (!g) { g = { name, labels, buckets: new Map() }; groups.set(key, g); }
    const bucket = Math.floor(time / 60000) * 60000;
    g.buckets.set(bucket, (g.buckets.get(bucket) || 0) + value);
  }
  for (const row of [...rows].sort((a, b) => a.timestamp - b.timestamp)) {
    // Never publish an unfinished minute: later requests would change an existing sample.
    if (row.timestamp >= closedBefore) continue;
    const labels = { tool: row.tool, provider: row.provider, model: row.model, project: row.project, component: row.component, user: row.user, team: row.team };
    for (const t of tokenTypes) add('ai_tokens_total', { ...labels, token_type: t }, row.timestamp, row.tokens[t]);
    if (row.costBasis !== 'unpriced') add('ai_cost_usd_total', labels, row.timestamp, row.cost);
    add('ai_requests_total', labels, row.timestamp, 1);
    const session = `${row.tool}:${row.session}`;
    if (!sessions.has(session)) { add('ai_sessions_total', { tool: row.tool, project: row.project, user: row.user }, row.timestamp, 1); sessions.add(session); }
  }
  const cutoff = Math.floor((now - days * 86400000) / 60000) * 60000;
  return [...groups.entries()].map(([key, g]) => {
    const entries = [...g.buckets].sort((a, b) => a[0] - b[0]);
    const start = entries[0][0] - 60000;
    let total = 0;
    const points: Point[] = [];
    const point = (time: number, value: number): Point => ({ timeUnixNano: nano(time), startTimeUnixNano: nano(start), asDouble: value, attributes: attrs(g.labels) });
    if (start >= cutoff) points.push(point(start, 0));
    for (const [time, value] of entries) { total += value; if (time >= cutoff) points.push(point(time, total)); }
    const latest = closedBefore - 60000;
    if (!points.length || points.at(-1)!.timeUnixNano !== nano(latest)) points.push(point(latest, total));
    return { name: g.name, key: createHash('sha256').update(key).digest('hex'), points };
  });
}
export function payload(item: Series, device: string) {
  return { resourceMetrics: [{ resource: { attributes: attrs({ 'service.name': 'costly', 'service.instance.id': device }) }, scopeMetrics: [{ scope: { name: 'costly', version: '0.0.1' }, metrics: [{ name: item.name, sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints: item.points } }] }] }] };
}
export async function authHeaders(config: Config): Promise<Record<string, string>> {
  if (!config.secret_ref) return {};
  const token = await Bun.secrets.get({ service: 'costly', name: config.secret_ref });
  if (!token) throw new Error('Credential unavailable in OS keychain; run costly setup again.');
  return { Authorization: config.auth === 'basic' ? 'Basic ' + Buffer.from(`${config.instance_id || ''}:${token}`).toString('base64') : 'Bearer ' + token };
}
/** `rejected` = the backend refused this data (a permanent 4xx); retrying the same points will not help. */
export class PushError extends Error {
  constructor(message: string, readonly rejected = false) { super(message); }
}
export async function post(config: Config, body: unknown, headers: Record<string, string> = {}) {
  if (!config.endpoint) throw new PushError('Not connected; run costly setup.');
  let response: Response;
  try { response = await fetch(validateEndpoint(config.endpoint), { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000), redirect: 'error' }); }
  catch { throw new PushError('Connection failed: check network, endpoint and TLS certificate.'); }
  const text = await response.text();
  if (response.status === 401 || response.status === 403) throw new PushError('Authentication failed; check the token and permissions.');
  if (!response.ok) {
    // Never expose server response text; it may contain submitted credentials or labels.
    const rejected = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429;
    throw new PushError(`Metrics endpoint returned HTTP ${response.status}.`, rejected);
  }
  if (text.trim()) {
    let result;
    try { result = JSON.parse(text); } catch { throw new PushError('Endpoint returned invalid OTLP JSON.'); }
    if (Number(result.partialSuccess?.rejectedDataPoints) > 0) throw new PushError('Endpoint rejected some points.', true);
  }
}

/**
 * What was last accepted for one series. Sent points are never changed or resent:
 * new points always come after `time`, so a counter never goes backwards in the backend.
 * Usage imported late (timestamp before `time`) simply shows up in the next new point.
 */
interface Sent { time: number; value: number; mode?: 'now' }
function stateKeyFor(config: Config, key: string) { return 'sent:' + createHash('sha256').update(config.endpoint || '').digest('hex').slice(0, 12) + ':' + key; }
function readSent(store: Store, stateKey: string): Sent {
  const raw = JSON.parse(store.get(stateKey) || '{}');
  if (typeof raw.time === 'number') return raw;
  // Older format: a map of nanosecond timestamp -> acknowledged value.
  let sent: Sent = { time: -Infinity, value: 0 };
  for (const [nanos, value] of Object.entries(raw)) { const time = Number(BigInt(nanos) / 1000000n); if (time > sent.time) sent = { time, value: Number(value) }; }
  if (store.get(stateKey + ':mode') === 'now') sent.mode = 'now';
  return sent;
}
const timeOf = (p: Point) => Number(BigInt(p.timeUnixNano) / 1000000n);
function newPoints(item: Series, sent: Sent, nowMode: boolean, now: number): Point[] {
  const fresh = item.points.filter(p => timeOf(p) > sent.time).map(p => ({ ...p, asDouble: Math.max(p.asDouble, sent.value) }));
  if (!fresh.length) return [];
  // "now" mode (backends that refuse old timestamps): one current total stamped with the push time.
  return nowMode ? [{ ...fresh.at(-1)!, timeUnixNano: nano(now) }] : fresh;
}
export function pendingPoints(store: Store, config: Config, now = Date.now()) {
  return series(store.rows(), now, config.backfill_days ?? 30).reduce((sum, item) => {
    const sent = readSent(store, stateKeyFor(config, item.key));
    return sum + newPoints(item, sent, config.history_mode === 'now' || sent.mode === 'now', now).length;
  }, 0);
}
export async function push(store: Store, config: Config, device: string, now = Date.now()) {
  if (!config.endpoint) return { sent: 0, connected: false, rejectedSeries: 0 };
  const headers = await authHeaders(config);
  let sent = 0, rejectedSeries = 0;
  for (const item of series(store.rows(), now, config.backfill_days ?? 30)) {
    const stateKey = stateKeyFor(config, item.key);
    const state = readSent(store, stateKey);
    const nowMode = config.history_mode === 'now' || state.mode === 'now';
    const points = newPoints(item, state, nowMode, now);
    if (!points.length) continue;
    const latest = item.points.at(-1)!;
    const save = (s: Sent) => store.set(stateKey, JSON.stringify(s));
    try {
      for (let i = 0; i < points.length; i += 500) {
        const batch = points.slice(i, i + 500);
        await post(config, payload({ ...item, points: batch }, device), headers);
        const last = nowMode ? latest : batch.at(-1)!;
        save({ time: timeOf(last), value: batch.at(-1)!.asDouble, ...(nowMode ? { mode: 'now' as const } : {}) });
        sent += batch.length;
      }
    } catch (e) {
      // Network, auth or server errors: stop and retry the whole push later.
      if (!(e instanceof PushError) || !e.rejected) throw e;
      // The backend refused these points (e.g. too old). Fall back to one current total for this series.
      const fallback = { ...latest, asDouble: Math.max(latest.asDouble, state.value), timeUnixNano: nano(now) };
      try {
        if (nowMode) throw e;
        await post(config, payload({ ...item, points: [fallback] }, device), headers);
        save({ time: timeOf(latest), value: fallback.asDouble, mode: 'now' }); sent++;
      } catch (again) {
        if (!(again instanceof PushError) || !again.rejected) throw again;
        // Permanently refused: skip this series for now, keep pushing the others.
        rejectedSeries++;
      }
    }
  }
  store.set('lastPush', new Date(now).toISOString());
  store.set('rejectedSeries', String(rejectedSeries));
  return { sent, connected: true, rejectedSeries };
}
