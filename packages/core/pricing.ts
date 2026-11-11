import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Usage, RecordUsage, Tokens } from './types';
import { tokenTypes } from './types';
import bundled from './prices/bundled.json';
import bedrock from './prices/bedrock.json';
export type Rates = Partial<Tokens>;
export interface PriceTable { version: string; models: Record<string, Rates> }
const source = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
export function calculate(usage: Usage, table: PriceTable): Pick<RecordUsage, 'cost' | 'costBasis' | 'priceVersion'> {
  const base = { priceVersion: table.version };
  if (usage.reportedCost !== undefined && Number.isFinite(usage.reportedCost) && usage.reportedCost >= 0) return { ...base, cost: usage.reportedCost, costBasis: 'provider_reported' };
  if (usage.provider === 'local') return { ...base, cost: 0, costBasis: 'calculated' };
  const rates = table.models[`${usage.provider}/${usage.region || ''}/${usage.model}`] || table.models[`${usage.provider}/${usage.model}`] || (!['bedrock', 'vertex', 'unknown'].includes(usage.provider) ? table.models[usage.model] : undefined);
  if (!rates || tokenTypes.some(t => usage.tokens[t] > 0 && rates[t] === undefined)) return { ...base, cost: 0, costBasis: 'unpriced' };
  const cost = tokenTypes.reduce((sum, t) => sum + usage.tokens[t] * (rates[t] || 0), 0);
  return { ...base, cost: Math.round(cost * 1e12) / 1e12, costBasis: 'calculated' };
}
/** LiteLLM provider names differ from costly's (e.g. `vertex_ai-anthropic_models`, `bedrock_converse`). */
export function costlyProvider(litellm: string): string | undefined {
  if (litellm.startsWith('vertex_ai')) return 'vertex';
  if (litellm === 'bedrock' || litellm === 'bedrock_converse') return 'bedrock';
  if (litellm === 'anthropic' || litellm === 'openai') return litellm;
  return undefined;
}
/** Lookup keys for one LiteLLM entry. LiteLLM sometimes prefixes the model with its provider ("vertex_ai/claude-…"). */
export function priceKeys(model: string, litellmProvider: unknown): string[] {
  if (typeof litellmProvider !== 'string') return [];
  const keys = [`${litellmProvider}/${model}`];
  const mapped = costlyProvider(litellmProvider);
  if (mapped) {
    const parts = model.split('/');
    // "provider/model" → "costly-provider/model"; "bedrock/region/model" is already a region-specific key.
    if (parts.length === 1) keys.push(`${mapped}/${model}`);
    else if (parts.length === 2) keys.push(`${mapped}/${parts[1]}`);
  }
  return keys;
}
export async function prices(home: string, override?: string, refresh = true): Promise<PriceTable> {
  const cache = join(home, 'prices.json');
  let table: PriceTable = bundled;
  if (existsSync(cache)) { try { table = JSON.parse(readFileSync(cache, 'utf8')); } catch { /* corrupt cache is replaceable */ } }
  if (refresh && (!existsSync(cache) || Date.now() - (await Bun.file(cache).stat()).mtimeMs > 86400000)) {
    try {
      const response = await fetch(source, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('price download failed');
      const text = await response.text();
      const raw = JSON.parse(text) as Record<string, Record<string, unknown>>;
      const models: Record<string, Rates> = {};
      for (const [model, r] of Object.entries(raw)) {
        if (typeof r.input_cost_per_token !== 'number' || typeof r.output_cost_per_token !== 'number') continue;
        const rate: Rates = { input: r.input_cost_per_token, output: r.output_cost_per_token };
        const mappings = { cache_read: 'cache_read_input_token_cost', cache_write: 'cache_creation_input_token_cost', cache_write_1h: 'cache_creation_input_token_cost_above_1hr' } as const;
        for (const [token, field] of Object.entries(mappings)) if (typeof r[field] === 'number' && Number.isFinite(r[field]) && (r[field] as number) >= 0) rate[token as keyof Rates] = r[field] as number;
        if (Object.values(rate).some(n => !Number.isFinite(n) || n < 0)) continue;
        models[model] = rate;
        for (const key of priceKeys(model, r.litellm_provider)) models[key] ??= rate;
      }
      table = { version: 'litellm:' + createHash('sha256').update(text).digest('hex').slice(0, 16), models };
      writeFileSync(cache, JSON.stringify(table), { mode: 0o600 });
    } catch { /* retain last known prices; unknown models remain explicitly unpriced */ }
  }
  table = { version: table.version + '+' + bedrock.version, models: { ...table.models, ...bedrock.models } };
  if (override) {
    const overrides = JSON.parse(readFileSync(override, 'utf8')) as PriceTable;
    for (const rates of Object.values(overrides.models)) if (Object.values(rates).some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0)) throw new Error('Invalid price override.');
    table = { version: table.version + '+' + overrides.version, models: { ...table.models, ...overrides.models } };
  }
  return table;
}
