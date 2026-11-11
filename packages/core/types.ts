export type Provider = 'anthropic' | 'openai' | 'subscription' | 'bedrock' | 'vertex' | 'local' | 'unknown';
export const tokenTypes = ['input', 'output', 'cache_read', 'cache_write', 'cache_write_1h'] as const;
export type Tokens = Record<typeof tokenTypes[number], number>;
export interface Usage {
  id: string; session: string; tool: 'claude-code' | 'codex'; timestamp: number;
  cwd: string; model: string; provider: Provider; tokens: Tokens;
  region?: string; reportedCost?: number;
}
export interface Labels { project: string; component: string; team: string; user: string }
export interface RecordUsage extends Usage, Labels {
  identitySource: string; remote: string; branch: string; cost: number;
  costBasis: 'provider_reported' | 'calculated' | 'unpriced'; priceVersion: string;
}
export interface Rule { match_path?: string; match_remote?: string; match_branch?: string; project: string; component?: string; team?: string }
export interface Config {
  user?: string; user_mode?: 'email' | 'hash'; user_hash_key?: string; team?: string;
  allowed_email_domains?: string[]; user_alias?: { from: string; to: string }[];
  rule?: Rule[]; email_template?: string;
  claude_dir?: string; codex_dir?: string; price_file?: string;
  endpoint?: string; secret_ref?: string; instance_id?: string;
  auth?: 'bearer' | 'basic'; backfill_days?: number; interval_seconds?: number; scan_seconds?: number;
  history_mode?: 'event' | 'now';
}
export const emptyTokens = (): Tokens => ({ input: 0, output: 0, cache_read: 0, cache_write: 0, cache_write_1h: 0 });
export function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
