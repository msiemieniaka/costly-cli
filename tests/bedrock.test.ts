import { test, expect } from 'bun:test';
import bedrock from '../packages/core/prices/bedrock.json';
import { calculate } from '../packages/core/pricing';
import { row } from './core.test';
test('AWS Sonnet 4.6 us-east-1 global and geographic rates, both cache tiers', () => {
  const tokens = { input: 1000000, output: 200000, cache_read: 500000, cache_write: 100000, cache_write_1h: 100000 };
  // Global: 3 + 3 + .15 + .375 + .6 = 7.125.
  // Geographic: 3.3 + 3.3 + .165 + .4125 + .66 = 7.8375.
  expect(calculate(row({ model: 'global.anthropic.claude-sonnet-4-6', provider: 'bedrock', region: 'us-east-1', tokens }), bedrock).cost).toBe(7.125);
  expect(calculate(row({ model: 'us.anthropic.claude-sonnet-4-6', provider: 'bedrock', region: 'us-east-1', tokens }), bedrock).cost).toBe(7.8375);
  expect(calculate(row({ model: 'us.anthropic.claude-sonnet-4-6', provider: 'bedrock', region: 'ap-south-1', tokens }), bedrock).costBasis).toBe('unpriced');
});
