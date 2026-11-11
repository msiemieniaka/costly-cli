import { Store } from '../packages/core/store';
import { push } from '../packages/collector/metrics';
import { emptyTokens, type RecordUsage } from '../packages/core/types';
const now = Date.now();
const project = 'synthetic-' + crypto.randomUUID().slice(0, 8);
const stores = [new Store(':memory:'), new Store(':memory:')];
const config = { endpoint: 'http://127.0.0.1:4318' };
try {
  for (let i = 0; i < stores.length; i++) {
    const row: RecordUsage = { id: `synthetic-${i}`, session: `synthetic-${i}`, tool: 'claude-code', timestamp: now - 3600000, cwd: '', model: 'synthetic-model', provider: 'anthropic', tokens: { ...emptyTokens(), input: 1000 }, project, component: 'api', team: 'synthetic', user: `dev${i}@example.invalid`, identitySource: 'config', remote: '', branch: '', cost: i + 1, costBasis: 'calculated', priceVersion: 'synthetic' };
    stores[i].put(row);
    await push(stores[i], config, project + '-' + i, now);
    if ((await push(stores[i], config, project + '-' + i, now)).sent !== 0) throw new Error('Duplicate push after restart state.');
  }
  const query = async (expression: string) => {
    const response = await fetch('http://127.0.0.1:9090/api/v1/query?query=' + encodeURIComponent(expression));
    const data = await response.json() as any;
    if (data.status !== 'success') throw new Error('Prometheus query failed.');
    return data.data.result;
  };
  const sum = await query(`sum(ai_cost_usd_total{project="${project}"})`);
  if (Number(sum[0]?.value[1]) !== 3) throw new Error('Team total mismatch: ' + JSON.stringify(sum));
  const users = await query(`sum by (user) (ai_cost_usd_total{project="${project}"})`);
  if (users.length !== 2) throw new Error('Users were merged.');
  const historical = await query(`sum(increase(ai_cost_usd_total{project="${project}"}[2h]))`);
  if (Number(historical[0]?.value[1]) < 3) throw new Error('Historical increase missing.');
  const dashboard = await fetch('http://127.0.0.1:3000/api/dashboards/uid/costly');
  if (!dashboard.ok || !(await dashboard.json() as any).dashboard.panels.length) throw new Error('Dashboard missing.');
  console.log(JSON.stringify({ project, teamUSD: 3, users: 2, restartDuplicatePoints: 0, historicalIncrease: Number(historical[0].value[1]), dashboard: 'provisioned' }));
} finally { for (const s of stores) s.close(); }
