import { Store } from '../packages/core/store';
import { join } from 'node:path';
const home = process.env.COSTLY_CHECK_HOME;
if (!home) throw new Error('Set COSTLY_CHECK_HOME to the scratch directory used by real-check.');
const reference = await Bun.file(join(home, 'ccusage.json')).json();
const store = new Store(join(home, 'real-check.sqlite'));
try {
  const rows = store.rows().filter(r => r.tool === 'claude-code');
  const cost = rows.reduce((sum, r) => sum + r.cost, 0);
  const tokens = rows.reduce((sum, r) => sum + Object.values(r.tokens).reduce((a, b) => a + b, 0), 0);
  const expected = reference.totals.totalCost;
  const differencePercent = expected ? Math.abs(cost - expected) / expected * 100 : cost ? 100 : 0;
  console.log(JSON.stringify({ costlyUSD: cost, ccusageUSD: expected, costlyTokens: tokens, ccusageTokens: reference.totals.totalTokens, differencePercent, pass: differencePercent <= 2 }));
  if (differencePercent > 2) process.exitCode = 1;
} finally { store.close(); }
