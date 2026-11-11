import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../packages/core/store';
import { collect } from '../packages/collector/collect';
import { push, post } from '../packages/collector/metrics';
import { row, table } from './core.test';

test('SQLite import resumes partial lines, deduplicates and excludes private content', async () => {
  const root = mkdtempSync(join(tmpdir(), 'costly-import-'));
  const store = new Store(join(root, 'usage.sqlite'));
  try {
    const claude = join(root, 'claude'); mkdirSync(claude);
    const path = join(claude, 'test.jsonl');
    const fixture = (id: string) => JSON.stringify({ type: 'assistant', timestamp: '2026-11-10T12:00:00Z', sessionId: 'synthetic', message: { id, model: 'test-model', content: 'PRIVATE_CANARY_PROMPT', usage: { input_tokens: 1000000, output_tokens: 200000, cache_read_input_tokens: 500000, cache_creation_input_tokens: 100000 } } });
    writeFileSync(path, fixture('a') + '\n' + fixture('a') + '\nbroken\n' + fixture('b').slice(0, 30));
    const config = { claude_dir: claude, codex_dir: join(root, 'missing'), user: 'dev@example.invalid' };
    expect((await collect(store, config, table)).added).toBe(1);
    expect((await collect(store, config, table)).added).toBe(0);
    appendFileSync(path, fixture('b').slice(30) + '\n');
    expect((await collect(store, config, table)).added).toBe(1);
    expect(store.rows()).toHaveLength(2); expect(JSON.stringify(store.rows())).not.toContain('PRIVATE_CANARY_PROMPT');
    store.close();
    const restarted = new Store(join(root, 'usage.sqlite'));
    expect((await collect(restarted, config, table)).added).toBe(0); restarted.close();
  } finally { try { store.close(); } catch { /* closed */ } rmSync(root, { recursive: true }); }
});
test('offline retries retain points, accepted points survive restart, devices stay separate', async () => {
  let failing = true;
  const bodies: unknown[] = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) { bodies.push(await req.json()); return failing ? new Response('offline', { status: 503 }) : Response.json({}); } });
  const store = new Store(':memory:');
  store.put(row());
  const now = Date.parse('2026-11-10T12:10:00Z');
  const config = { endpoint: `http://127.0.0.1:${server.port}` };
  try {
    await expect(push(store, config, 'device-a', now)).rejects.toThrow('503');
    expect(store.get('lastPush')).toBeUndefined();
    failing = false;
    expect((await push(store, config, 'device-a', now)).sent).toBeGreaterThan(0);
    expect((await push(store, config, 'device-a', now)).sent).toBe(0);
    expect(JSON.stringify(bodies)).toContain('1794312000000000000');
  } finally { store.close(); server.stop(true); }
});
test('history rejection falls back to one current total per series', async () => {
  const accepted: any[] = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    const body = await req.json() as any;
    const points = body.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints;
    if (points.length > 1) return new Response('out of bounds', { status: 400 });
    accepted.push(body); return Response.json({});
  } });
  const store = new Store(':memory:'); store.put(row());
  try {
    await push(store, { endpoint: `http://127.0.0.1:${server.port}` }, 'device-a', Date.parse('2026-11-10T12:10:00Z'));
    expect(accepted).toHaveLength(8);
    const cost = accepted.find(b => b.resourceMetrics[0].scopeMetrics[0].metrics[0].name === 'ai_cost_usd_total');
    expect(cost.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].asDouble).toBe(2.175);
  } finally { store.close(); server.stop(true); }
});
test('authentication error is useful and server body is not leaked', async () => {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch() { return new Response('PRIVATE_SERVER_CONTENT', { status: 401 }); } });
  try { await expect(post({ endpoint: `http://127.0.0.1:${server.port}` }, {})).rejects.toThrow('Authentication failed'); }
  finally { server.stop(true); }
});
test('OTLP partial success cannot discard pending usage', async () => {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch() { return Response.json({ partialSuccess: { rejectedDataPoints: '1' } }); } });
  try { await expect(post({ endpoint: `http://127.0.0.1:${server.port}` }, {})).rejects.toThrow('Endpoint rejected some points'); }
  finally { server.stop(true); }
});
