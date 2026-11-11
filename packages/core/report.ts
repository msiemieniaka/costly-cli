import { tokenTypes, type RecordUsage } from './types';
const dimensions = ['project', 'component', 'user', 'team', 'model', 'provider', 'tool', 'session', 'day'] as const;
export function report(rows: RecordUsage[], by = 'project,model') {
  const fields = by.split(',');
  if (fields.some(f => !dimensions.includes(f as typeof dimensions[number]))) throw new Error('Unsupported report grouping.');
  const groups = new Map<string, Record<string, string | number>>();
  for (const r of rows) {
    const values = Object.fromEntries(fields.map(f => [f, f === 'day' ? new Date(r.timestamp).toISOString().slice(0, 10) : r[f as keyof RecordUsage]])) as Record<string, string>;
    const key = JSON.stringify(values);
    const g = groups.get(key) || { ...values, tokens: 0, estimated_usd: 0, unpriced_tokens: 0, requests: 0 };
    const tokens = tokenTypes.reduce((sum, t) => sum + r.tokens[t], 0);
    g.tokens = Number(g.tokens) + tokens; g.estimated_usd = Number(g.estimated_usd) + r.cost;
    g.unpriced_tokens = Number(g.unpriced_tokens) + (r.costBasis === 'unpriced' ? tokens : 0);
    g.requests = Number(g.requests) + 1; groups.set(key, g);
  }
  return [...groups.values()];
}
export function csv(rows: Record<string, string | number>[], excel = false) {
  if (!rows.length) return excel ? '\ufeff' : '';
  const delimiter = excel ? ';' : ',';
  const cell = (v: string | number) => {
    let s = String(v);
    if (typeof v === 'string' && /^[\s]*[=+@\-]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const fields = Object.keys(rows[0]);
  return (excel ? '\ufeff' : '') + [fields.map(cell).join(delimiter), ...rows.map(r => fields.map(f => cell(r[f])).join(delimiter))].join('\r\n') + '\r\n';
}
