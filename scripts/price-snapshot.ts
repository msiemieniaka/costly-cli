// Explicit maintenance task: downloads public prices only; no session data leaves the machine.
import { mkdirSync } from 'node:fs';
import { prices } from '../packages/core/pricing';
const cache = process.env.COSTLY_PRICE_CACHE;
if (!cache) throw new Error('Set COSTLY_PRICE_CACHE to a local scratch directory.');
mkdirSync(cache, { recursive: true });
const table = await prices(cache);
const selected = Object.fromEntries(Object.entries(table.models).filter(([key]) => /^(claude-|gpt-|openai\/gpt-|anthropic\/claude-|bedrock\/(us\.|global\.)?anthropic\.claude-)/.test(key)));
await Bun.write(new URL('../packages/core/prices/bundled.json', import.meta.url), JSON.stringify({ version: table.version, models: selected }, null, 2));
console.log(JSON.stringify({ version: table.version, modelKeys: Object.keys(selected).length }));
