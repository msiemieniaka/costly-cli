import { createHash } from 'node:crypto';
import type { Provider, Usage } from '../core/types';
import { count, emptyTokens } from '../core/types';

export interface ReaderState { session: string; cwd: string; model: string; provider: string; totals: number[] }
export const readerState = (): ReaderState => ({ session: '', cwd: '', model: 'unknown', provider: '', totals: [0, 0, 0] });
export function provider(model: string, hint = '', env: NodeJS.ProcessEnv = {}): Provider {
  if (hint === 'local' || ['ollama', 'lmstudio'].includes(hint)) return 'local';
  if (hint === 'subscription') return 'subscription';
  if (env.CLAUDE_CODE_USE_BEDROCK === '1' || /(^|\.)anthropic\./.test(model) || hint === 'bedrock') return 'bedrock';
  if (env.CLAUDE_CODE_USE_VERTEX === '1' || /@\d{8}$/.test(model) || hint === 'vertex') return 'vertex';
  if (hint && !['openai', 'anthropic'].includes(hint)) return 'unknown';
  if (/^claude-/.test(model) || hint === 'anthropic') return 'anthropic';
  if (/^(gpt-|o[134]-|codex-)/.test(model) || hint === 'openai') return 'openai';
  return 'unknown';
}
// Only allow-listed usage fields survive this function. Prompt/content fields never leave it.
export function parseLine(line: string, tool: Usage['tool'], state: ReaderState, env: NodeJS.ProcessEnv = {}): Usage | undefined {
  const row = JSON.parse(line);
  const timestamp = Date.parse(row.timestamp);
  if (tool === 'claude-code') {
    if (!state.cwd && typeof row.cwd === 'string') state.cwd = row.cwd;
    if (typeof row.sessionId === 'string') state.session = row.sessionId;
    if (row.type !== 'assistant' || !row.message?.usage || !row.message?.id || !Number.isFinite(timestamp)) return;
    const u = row.message.usage;
    const model = String(row.message.model || 'unknown');
    const hour = count(u.cache_creation?.ephemeral_1h_input_tokens);
    const totalWrite = count(u.cache_creation_input_tokens);
    return {
      id: 'claude:' + row.message.id + ':' + (row.requestId || ''), session: state.session || row.message.id,
      tool, timestamp, cwd: state.cwd, model, provider: provider(model, '', env),
      tokens: { input: count(u.input_tokens), output: count(u.output_tokens), cache_read: count(u.cache_read_input_tokens), cache_write: Math.max(0, totalWrite - hour), cache_write_1h: hour },
    };
  }
  const p = row.payload;
  if (row.type === 'session_meta') {
    state.session = String(p?.id || state.session);
    if (!state.cwd) state.cwd = String(p?.cwd || '');
    state.provider = String(p?.model_provider || state.provider);
  }
  if (row.type === 'turn_context') {
    state.model = String(p?.model || state.model);
    if (!state.cwd) state.cwd = String(p?.cwd || '');
  }
  if (row.type !== 'event_msg' || p?.type !== 'token_count' || !p.info?.total_token_usage || !Number.isFinite(timestamp)) return;
  const u = p.info.total_token_usage;
  const next = [count(u.input_tokens), count(u.cached_input_tokens), count(u.output_tokens)];
  // Codex repeats totals in rate-limit events. Reasoning is already part of output.
  if (next.every((n, i) => n === state.totals[i])) return;
  if (next.some((n, i) => n < state.totals[i])) { state.totals = next; return; }
  const delta = next.map((n, i) => n - state.totals[i]);
  state.totals = next;
  const tokens = emptyTokens();
  tokens.input = Math.max(0, delta[0] - delta[1]); tokens.cache_read = delta[1]; tokens.output = delta[2];
  const id = createHash('sha256').update(`${state.session}:${next.join(':')}`).digest('hex');
  return { id: 'codex:' + id, session: state.session, tool, timestamp, cwd: state.cwd, model: state.model, provider: provider(state.model, state.provider, env), tokens };
}
