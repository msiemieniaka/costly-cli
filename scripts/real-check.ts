// Local-only validation. Prints aggregate counts, never identities, paths, or session text.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../packages/core/store';
import { prices } from '../packages/core/pricing';
import { collect } from '../packages/collector/collect';
const home = process.env.COSTLY_CHECK_HOME;
if (!home) throw new Error('Set COSTLY_CHECK_HOME to a scratch directory outside the repository.');
mkdirSync(home, { recursive: true });
const store = new Store(join(home, 'real-check.sqlite'));
try {
  const table = await prices(home);
  const first = await collect(store, {}, table);
  const before = store.rows();
  const second = await collect(store, {}, table);
  const after = store.rows();
  console.log(JSON.stringify({ first, second, records: after.length, tokens: after.reduce((n, r) => n + Object.values(r.tokens).reduce((a, b) => a + b, 0), 0), tools: Object.fromEntries(['claude-code', 'codex'].map(t => [t, after.filter(r => r.tool === t).length])), unpriced: after.filter(r => r.costBasis === 'unpriced').length, stable: before.length === after.length, priceVersion: table.version }));
} finally { store.close(); }
