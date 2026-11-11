import { test, expect } from 'bun:test';
import { Store } from '../packages/core/store';
import { row } from './core.test';
import { series } from '../packages/collector/metrics';
import { project } from '../packages/core/attribution';
test('streamed completion updates usage once but duplicate does not reprice', () => {
  const store = new Store(':memory:');
  try {
    store.put(row({ tokens: { ...row().tokens, output: 0 }, cost: 1.175 }));
    store.put(row());
    store.put(row({ cost: 99, priceVersion: 'changed' }));
    expect(store.rows()).toHaveLength(1); expect(store.rows()[0].cost).toBe(2.175);
  } finally { store.close(); }
});
test('unfinished minute cannot create conflicting counter values', () => {
  const now = Date.parse('2026-11-10T12:00:30Z');
  expect(series([row()], now)).toHaveLength(0);
  expect(series([row()], now + 60000).length).toBeGreaterThan(0);
});
test('saved remote can be remapped after checkout disappears', () => {
  expect(project('/missing/synthetic/repo', { rule: [{ match_remote: 'github.com/example/*', project: 'renamed' }] }, {}, { remote: 'github.com/example/api', branch: 'main', component: 'api' }).project).toBe('renamed');
});
