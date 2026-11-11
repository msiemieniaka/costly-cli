import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLine, readerState, provider } from '../packages/collector/readers';
import { calculate, type PriceTable } from '../packages/core/pricing';
import { identity, project, normalizeRemote } from '../packages/core/attribution';
import { emptyTokens, type RecordUsage } from '../packages/core/types';
import { csv, report } from '../packages/core/report';
import { series, payload } from '../packages/collector/metrics';
import { validateEndpoint } from '../packages/core/config';

export const table: PriceTable = { version: 'synthetic-v1', models: { 'test-model': { input: .000001, output: .000005, cache_read: .0000001, cache_write: .00000125, cache_write_1h: .000002 } } };
export function row(overrides: Partial<RecordUsage> = {}): RecordUsage {
  return { id: 'synthetic-1', session: 'synthetic-session', tool: 'claude-code', timestamp: Date.parse('2026-11-10T12:00:00Z'), cwd: '', model: 'test-model', provider: 'anthropic', tokens: { ...emptyTokens(), input: 1000000, output: 200000, cache_read: 500000, cache_write: 100000 }, project: 'demo', component: 'api', team: '', user: 'dev@example.invalid', identitySource: 'config', remote: '', branch: '', cost: 2.175, costBasis: 'calculated', priceVersion: table.version, ...overrides };
}
test('synthetic hand calculation is exactly 2.175 USD', () => expect(calculate(row(), table).cost).toBe(2.175));
test('each cache tier has a distinct price', () => {
  for (const [token, expected] of Object.entries({ input: 1, output: 5, cache_read: .1, cache_write: 1.25, cache_write_1h: 2 })) expect(calculate(row({ tokens: { ...emptyTokens(), [token]: 1000000 } }), table).cost).toBe(expected);
});
test('unknown model is unpriced, local is zero, reported cost wins', () => {
  expect(calculate(row({ model: 'missing' }), table).costBasis).toBe('unpriced');
  expect(calculate(row({ provider: 'local' }), table).cost).toBe(0);
  expect(calculate(row({ reportedCost: 7 }), table).cost).toBe(7);
});
test('Bedrock must not fall back to direct-provider prices', () => {
  expect(calculate(row({ provider: 'bedrock' }), table).costBasis).toBe('unpriced');
  expect(calculate(row({ provider: 'bedrock' }), { ...table, models: { 'bedrock/test-model': table.models['test-model'] } }).cost).toBe(2.175);
});
test('missing cache rate makes record explicitly unpriced', () => expect(calculate(row(), { version: 'x', models: { 'test-model': { input: 1, output: 1 } } }).costBasis).toBe('unpriced'));
test('Claude drops content and splits one-hour cache writes', () => {
  const got = parseLine(JSON.stringify({ type: 'assistant', sessionId: 's', timestamp: '2026-11-10T00:00:00Z', cwd: '/synthetic', message: { id: 'm', model: 'claude-test', content: 'PRIVATE_CANARY', usage: { input_tokens: 5, output_tokens: 7, cache_creation_input_tokens: 100, cache_creation: { ephemeral_1h_input_tokens: 40 } } } }), 'claude-code', readerState())!;
  expect(got.tokens.cache_write).toBe(60); expect(got.tokens.cache_write_1h).toBe(40); expect(JSON.stringify(got)).not.toContain('PRIVATE_CANARY');
});
test('Codex cumulative deltas exclude cached input and do not add reasoning twice', () => {
  const state = readerState();
  parseLine(JSON.stringify({ type: 'session_meta', payload: { id: 's', cwd: '/start', model_provider: 'openai' } }), 'codex', state);
  parseLine(JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-test', cwd: '/later' } }), 'codex', state);
  const event = (input: number, output: number) => JSON.stringify({ timestamp: '2026-11-10T01:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 20, output_tokens: output, reasoning_output_tokens: 5 } } } });
  const first = parseLine(event(100, 10), 'codex', state)!;
  expect(first.tokens).toEqual({ ...emptyTokens(), input: 80, cache_read: 20, output: 10 });
  expect(first.cwd).toBe('/start'); expect(parseLine(event(100, 10), 'codex', state)).toBeUndefined();
  expect(parseLine(event(150, 20), 'codex', state)!.tokens.input).toBe(50);
});
test('provider detection is conservative', () => {
  expect(provider('us.anthropic.claude-sonnet-4-20250514-v1:0')).toBe('bedrock');
  expect(provider('claude-sonnet@20250514')).toBe('vertex');
  expect(provider('custom', 'ollama')).toBe('local');
  expect(provider('gpt-test', 'custom-proxy')).toBe('unknown');
});
test('identity only invokes AWS when Bedrock is detected', () => {
  const calls: string[][] = [];
  const run = (args: string[]) => { calls.push(args); return args[0] === 'aws' ? JSON.stringify({ Arn: 'arn:aws:sts::111122223333:assumed-role/AWSReservedSSO_Dev/demo@example.invalid' }) : 'git@example.invalid'; };
  expect(identity({}, 'anthropic', '', run).source).toBe('git'); expect(calls.some(a => a[0] === 'aws')).toBe(false);
  expect(identity({}, 'bedrock', '', run).user).toBe('demo@example.invalid');
});
test('identity aliases, domain filter and hashing', () => {
  expect(identity({ user: 'OTHER@EXAMPLE.INVALID', user_alias: [{ from: 'other@example.invalid', to: 'dev@company.invalid' }], allowed_email_domains: ['company.invalid'] }, 'unknown', '', () => '').user).toBe('dev@company.invalid');
  expect(identity({ user: 'outside@example.invalid', allowed_email_domains: ['company.invalid'] }, 'unknown', '', () => 'dev@company.invalid').source).toBe('git');
  expect(identity({ user: 'dev@example.invalid', user_mode: 'hash' }, 'unknown').user).toHaveLength(64);
});
test('remote normalization', () => expect(normalizeRemote('git@github.com:example/demo.git')).toBe(normalizeRemote('https://github.com/example/demo')));
test('nearest marker beats mapping; environment beats marker', () => {
  const root = mkdtempSync(join(tmpdir(), 'costly-project-'));
  try {
    const sub = join(root, 'sub'); mkdirSync(sub);
    writeFileSync(join(root, '.costly.toml'), 'project="outer"');
    writeFileSync(join(sub, 'AGENTS.md'), '<!-- costly: project=inner component=api -->');
    expect(project(sub, { rule: [{ match_path: '*', project: 'rule' }] }, {}).project).toBe('inner');
    expect(project(sub, {}, { COSTLY_PROJECT: 'env' }).project).toBe('env');
  } finally { rmSync(root, { recursive: true }); }
});
test('mapping groups two components', () => {
  const config = { rule: [{ match_path: '/synthetic/*', project: 'shared' }] };
  expect(project('/synthetic/a', config, { COSTLY_COMPONENT: 'a' }).project).toBe('shared');
  expect(project('/synthetic/b', config, { COSTLY_COMPONENT: 'b' }).component).toBe('b');
});
test('CSV protects formula injection and preserves quotes and newlines', () => {
  const out = csv([{ project: '=CMD("x")', label: 'a\nb', estimated_usd: 2.175 }], true);
  expect(out.startsWith('\ufeff')).toBe(true); expect(out).toContain('"\'=CMD(""x"")";'); expect(out).toContain('"a\nb"');
});
test('report identifies unpriced tokens', () => {
  const result = report([row(), row({ id: '2', cost: 0, costBasis: 'unpriced' })]);
  expect(result[0].estimated_usd).toBe(2.175); expect(result[0].unpriced_tokens).toBe(1800000);
});
test('metrics use event times, baseline zero and stable cumulative totals', () => {
  const now = Date.parse('2026-11-10T12:10:00Z');
  const cost = series([row(), row({ id: '2', timestamp: now - 120000 })], now).find(s => s.name === 'ai_cost_usd_total')!;
  expect(cost.points.map(p => p.asDouble)).toEqual([0, 2.175, 4.35, 4.35]);
  expect(cost.points[1].timeUnixNano).toBe('1794312000000000000');
  expect(JSON.stringify(payload(cost, 'device-a'))).not.toContain('synthetic-session');
  expect(JSON.stringify(payload(cost, 'device-a'))).not.toBe(JSON.stringify(payload(cost, 'device-b')));
});
test('metrics count sessions once and retain all-time totals outside backfill', () => {
  const result = series([row(), row({ id: '2' })], Date.parse('2027-01-01T00:00:00Z'));
  expect(result.find(s => s.name === 'ai_sessions_total')!.points.at(-1)!.asDouble).toBe(1);
  expect(result.find(s => s.name === 'ai_cost_usd_total')!.points).toHaveLength(1);
});
test('endpoint rejects plaintext remote auth, credentials, and query tokens', () => {
  expect(validateEndpoint('http://127.0.0.1:4318')).toBe('http://127.0.0.1:4318/v1/metrics');
  expect(validateEndpoint('https://example.invalid/api/v1/otlp')).toBe('https://example.invalid/api/v1/otlp/v1/metrics');
  for (const url of ['http://example.invalid', 'https://u:p@example.invalid', 'https://example.invalid?token=x']) expect(() => validateEndpoint(url)).toThrow();
});
