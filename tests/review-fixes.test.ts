// Regression tests for the 2026-11-11 code review (H1–H3, M3–M6).
import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../packages/core/store';
import { push, pendingPoints } from '../packages/collector/metrics';
import { collect, setMaxLine, repriceUnpriced } from '../packages/collector/collect';
import { calculate, priceKeys } from '../packages/core/pricing';
import { hashUser } from '../packages/core/attribution';
import { loadConfig, saveConnection, loadConnection } from '../packages/core/config';
import { row, table } from './core.test';

type Body = { resourceMetrics: { scopeMetrics: { metrics: { name: string; sum: { dataPoints: { timeUnixNano: string; asDouble: number; attributes: unknown }[] } }[] }[] }[] };
const metric = (b: Body) => b.resourceMetrics[0].scopeMetrics[0].metrics[0];

/** Fake backend that behaves like Prometheus: a timestamp, once stored, cannot get a different value. */
function prometheusLike() {
  const stored = new Map<string, Map<string, number>>();
  let conflicts = 0;
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    const m = metric(await req.json() as Body);
    // One series = metric name + labels. Tests read the cost series, which has a single label set.
    const id = m.name === 'ai_cost_usd_total' ? m.name : m.name + JSON.stringify(m.sum.dataPoints[0]?.attributes);
    const series = stored.get(id) ?? new Map(); stored.set(id, series);
    for (const p of m.sum.dataPoints) {
      if (series.has(p.timeUnixNano) && series.get(p.timeUnixNano) !== p.asDouble) { conflicts++; return new Response('error exporting items', { status: 400 }); }
    }
    for (const p of m.sum.dataPoints) series.set(p.timeUnixNano, p.asDouble);
    return Response.json({});
  } });
  const values = (name: string) => [...(stored.get(name) ?? new Map<string, number>())].sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? -1 : 1)).map(e => e[1]);
  return { server, values, conflicts: () => conflicts, endpoint: `http://127.0.0.1:${server.port}` };
}

test('H1/H2: late row for an already-pushed minute never resends or lowers sent points', async () => {
  const backend = prometheusLike();
  const store = new Store(':memory:');
  try {
    const t0 = Date.parse('2026-11-10T12:00:00Z');
    store.put(row({ cost: 2 }));
    await push(store, { endpoint: backend.endpoint }, 'device-a', t0 + 10 * 60000);
    // Late import: usage stamped 12:03, after 12:09 was already sent.
    store.put(row({ id: 'late', timestamp: t0 + 3 * 60000, cost: 2 }));
    const second = await push(store, { endpoint: backend.endpoint }, 'device-a', t0 + 11 * 60000);
    expect(backend.conflicts()).toBe(0);
    expect(second.rejectedSeries).toBe(0);
    const cost = backend.values('ai_cost_usd_total');
    // Monotonic: no counter reset, so increase() counts the late $2 once.
    for (let i = 1; i < cost.length; i++) expect(cost[i]).toBeGreaterThanOrEqual(cost[i - 1]);
    expect(cost.at(-1)).toBe(4);
    expect(pendingPoints(store, { endpoint: backend.endpoint }, t0 + 11 * 60000)).toBe(0);
  } finally { store.close(); backend.server.stop(true); }
});

test('H1: streamed completion of an already-sent row goes into the next point', async () => {
  const backend = prometheusLike();
  const store = new Store(':memory:');
  try {
    const t0 = Date.parse('2026-11-10T12:00:00Z');
    store.put(row({ tokens: { ...row().tokens, output: 0 }, cost: 1 }));
    await push(store, { endpoint: backend.endpoint }, 'device-a', t0 + 5 * 60000);
    store.put(row({ cost: 3 }));
    await push(store, { endpoint: backend.endpoint }, 'device-a', t0 + 6 * 60000);
    expect(backend.conflicts()).toBe(0);
    expect(backend.values('ai_cost_usd_total').at(-1)).toBe(3);
  } finally { store.close(); backend.server.stop(true); }
});

test('H2: a series refused permanently does not block the others', async () => {
  const names: string[] = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    const m = metric(await req.json() as Body);
    if (m.name === 'ai_cost_usd_total') return new Response('nope', { status: 400 });
    names.push(m.name); return Response.json({});
  } });
  const store = new Store(':memory:'); store.put(row());
  try {
    const result = await push(store, { endpoint: `http://127.0.0.1:${server.port}` }, 'device-a', Date.parse('2026-11-10T12:10:00Z'));
    expect(result.rejectedSeries).toBe(1);
    expect(names).toContain('ai_requests_total');
    expect(names).toContain('ai_sessions_total');
  } finally { store.close(); server.stop(true); }
});

test('H2: server errors (5xx) still stop the push so it is retried', async () => {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch() { return new Response('down', { status: 503 }); } });
  const store = new Store(':memory:'); store.put(row());
  try { await expect(push(store, { endpoint: `http://127.0.0.1:${server.port}` }, 'd', Date.parse('2026-11-10T12:10:00Z'))).rejects.toThrow('503'); }
  finally { store.close(); server.stop(true); }
});

test('H2: old-format acknowledged state is migrated without resending', async () => {
  const backend = prometheusLike();
  const store = new Store(':memory:');
  try {
    const now = Date.parse('2026-11-10T12:10:00Z');
    await push(store, { endpoint: backend.endpoint }, 'd', now); // nothing yet
    store.put(row());
    await push(store, { endpoint: backend.endpoint }, 'd', now);
    // Rewrite state into the pre-fix map format and check nothing is pending.
    for (const { key, value } of store.states('sent:')) {
      const s = JSON.parse(value); store.set(key, JSON.stringify({ [(BigInt(s.time) * 1000000n).toString()]: s.value }));
    }
    expect(pendingPoints(store, { endpoint: backend.endpoint }, now)).toBe(0);
  } finally { store.close(); backend.server.stop(true); }
});

test('H3: setup saves only connection fields, so config.toml edits keep working', () => {
  const home = mkdtempSync(join(tmpdir(), 'costly-config-'));
  const previous = process.env.COSTLY_HOME;
  process.env.COSTLY_HOME = home;
  try {
    writeFileSync(join(home, 'config.toml'), 'team = "a"\n[[rule]]\nmatch_path = "/x/*"\nproject = "one"\n');
    saveConnection({ ...loadConfig(), endpoint: 'http://127.0.0.1:4318/v1/metrics' });
    const saved = JSON.parse(readFileSync(join(home, 'connection.json'), 'utf8'));
    expect(Object.keys(saved)).toEqual(['endpoint']);
    writeFileSync(join(home, 'config.toml'), 'team = "b"\n[[rule]]\nmatch_path = "/x/*"\nproject = "two"\n');
    expect(loadConfig().team).toBe('b');
    expect(loadConfig().rule?.[0].project).toBe('two');
    // Even an old connection.json full of other keys only contributes connection fields.
    writeFileSync(join(home, 'connection.json'), JSON.stringify({ endpoint: 'http://127.0.0.1:4318', team: 'stale', rule: [] }));
    expect(loadConnection()).toEqual({ endpoint: 'http://127.0.0.1:4318' });
    expect(loadConfig().team).toBe('b');
  } finally {
    if (previous === undefined) delete process.env.COSTLY_HOME; else process.env.COSTLY_HOME = previous;
    rmSync(home, { recursive: true });
  }
});

test('M4: an oversized line is skipped and later lines are still read', async () => {
  const root = mkdtempSync(join(tmpdir(), 'costly-long-'));
  const store = new Store(':memory:');
  setMaxLine(1024);
  try {
    const claude = join(root, 'claude'); mkdirSync(claude);
    const line = (id: string) => JSON.stringify({ type: 'assistant', timestamp: '2026-11-10T12:00:00Z', sessionId: 'synthetic', message: { id, model: 'test-model', usage: { input_tokens: 10, output_tokens: 1 } } });
    writeFileSync(join(claude, 'a.jsonl'), line('a') + '\n' + 'x'.repeat(200 * 1024) + '\n' + line('b') + '\n');
    const config = { claude_dir: claude, codex_dir: join(root, 'missing'), user: 'dev@example.invalid' };
    const first = await collect(store, config, table);
    expect(first.added).toBe(2); expect(first.invalid).toBe(1);
    expect((await collect(store, config, table)).added).toBe(0);
  } finally { setMaxLine(16 * 1024 * 1024); store.close(); if (existsSync(root)) rmSync(root, { recursive: true }); }
});

test('M3: unpriced rows get a price when the price list changes', () => {
  const store = new Store(':memory:');
  try {
    store.put(row({ model: 'new-model', cost: 0, costBasis: 'unpriced' }));
    expect(repriceUnpriced(store, table)).toBe(0);
    const updated = { version: 'synthetic-v2', models: { ...table.models, 'new-model': table.models['test-model'] } };
    expect(repriceUnpriced(store, updated)).toBe(1);
    expect(store.rows()[0].cost).toBe(2.175); expect(store.rows()[0].costBasis).toBe('calculated');
  } finally { store.close(); }
});

test('M5: LiteLLM provider names map to vertex and bedrock lookups', () => {
  expect(priceKeys('claude-test@20250101', 'vertex_ai-anthropic_models')).toContain('vertex/claude-test@20250101');
  expect(priceKeys('vertex_ai/claude-test@20250101', 'vertex_ai-anthropic_models')).toContain('vertex/claude-test@20250101');
  expect(priceKeys('anthropic.claude-test-v1:0', 'bedrock_converse')).toContain('bedrock/anthropic.claude-test-v1:0');
  expect(priceKeys('bedrock/us-east-1/anthropic.claude-test-v1:0', 'bedrock')).not.toContain('bedrock/anthropic.claude-test-v1:0');
  const models = Object.fromEntries(priceKeys('claude-test@20250101', 'vertex_ai-anthropic_models').map(k => [k, table.models['test-model']]));
  expect(calculate(row({ provider: 'vertex', model: 'claude-test@20250101' }), { version: 'x', models }).costBasis).toBe('calculated');
});

test('M6: hash mode uses an HMAC when a team key is set', () => {
  const plain = hashUser('dev@example.invalid', {}, {});
  const keyed = hashUser('dev@example.invalid', {}, { COSTLY_USER_HASH_KEY: 'team-secret' });
  expect(keyed).toHaveLength(64); expect(keyed).not.toBe(plain);
  expect(hashUser('dev@example.invalid', { user_hash_key: 'team-secret' }, {})).toBe(keyed);
});
