const panels = [
  ['Estimated USD in range', 'sum(increase(ai_cost_usd_total[$__range]))', 'stat'],
  ['Cost by project', 'sum by (project) (increase(ai_cost_usd_total[$__rate_interval]))', 'timeseries'],
  ['Cost by user', 'sum by (user) (increase(ai_cost_usd_total[$__range]))', 'bargauge'],
  ['Cost by model', 'sum by (model) (increase(ai_cost_usd_total[$__range]))', 'bargauge'],
  ['Cost by tool', 'sum by (tool) (increase(ai_cost_usd_total[$__range]))', 'bargauge'],
  ['Tokens by type', 'sum by (token_type) (increase(ai_tokens_total[$__range]))', 'bargauge'],
  ['Cache read share', 'sum(increase(ai_tokens_total{token_type="cache_read"}[$__range])) / clamp_min(sum(increase(ai_tokens_total{token_type=~"input|cache_read|cache_write|cache_write_1h"}[$__range])), 1)', 'stat'],
  ['Cost by project and user', 'sum by (project,user) (increase(ai_cost_usd_total[$__range]))', 'table'],
  ['Unassigned request share', 'sum(increase(ai_requests_total{project="unassigned"}[$__range])) / clamp_min(sum(increase(ai_requests_total[$__range])), 1)', 'stat'],
];
const dashboard = { uid: 'costly', title: 'AI Cost', schemaVersion: 39, version: 1, refresh: '30s', timezone: 'utc', time: { from: 'now-30d', to: 'now' }, panels: panels.map(([title, expr, type], i) => ({ id: i + 1, title, type, datasource: { type: 'prometheus', uid: 'costly-prometheus' }, gridPos: { x: (i % 2) * 12, y: Math.floor(i / 2) * 8, w: 12, h: 8 }, targets: [{ refId: 'A', expr, instant: type !== 'timeseries', legendFormat: '{{project}}{{user}}{{model}}{{tool}}{{token_type}}' }], fieldConfig: { defaults: { unit: title.includes('Cost') || title.includes('USD') ? 'currencyUSD' : title.includes('share') ? 'percentunit' : 'short' }, overrides: [] }, options: {} })) };
await Bun.write(new URL('../docker/grafana/dashboards/costly.json', import.meta.url), JSON.stringify(dashboard, null, 2));
