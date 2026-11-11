import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Usage } from '../core/types';
function json(path: string): any { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; } }
export function toolContext(tool: Usage['tool']) {
  const env = { ...process.env };
  let email = '', subscription = false;
  if (tool === 'claude-code') {
    const settings = json(join(homedir(), '.claude', 'settings.json'));
    for (const name of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'AWS_PROFILE', 'AWS_REGION']) if (typeof settings.env?.[name] === 'string') env[name] = settings.env[name];
    const account = json(join(homedir(), '.claude.json')).oauthAccount;
    email = typeof account?.emailAddress === 'string' ? account.emailAddress : '';
    subscription = !!email && !process.env.ANTHROPIC_API_KEY;
  } else {
    const auth = json(join(homedir(), '.codex', 'auth.json'));
    subscription = auth.auth_mode === 'chatgpt' || !!auth.tokens?.id_token;
    // Decode only the email claim locally; credentials are never stored in costly.
    try {
      const claims = JSON.parse(Buffer.from(auth.tokens.id_token.split('.')[1], 'base64url').toString());
      email = typeof claims.email === 'string' ? claims.email : '';
    } catch { /* no local login claim */ }
  }
  return { env, email, subscription };
}
