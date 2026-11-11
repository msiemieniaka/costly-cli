import { openSync, readSync, closeSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import type { Config, Usage } from '../core/types';
import { project, identity } from '../core/attribution';
import { calculate, type PriceTable } from '../core/pricing';
import { Store } from '../core/store';
import { parseLine, readerState, type ReaderState } from './readers';
import { toolContext } from './tool-context';
interface Cursor { offset: number; state: ReaderState; birth: number; skipping?: boolean }
// Identity lookups can call cloud CLIs (aws sts), so keep results for an hour across scans.
let identityCache = { created: 0, users: new Map<string, ReturnType<typeof identity>>() };
export function clearIdentityCache() { identityCache = { created: 0, users: new Map() }; }
export let maxLine = 16 * 1024 * 1024;
export function setMaxLine(bytes: number) { maxLine = bytes; } // for tests

/** When the price list changes, give a price to rows that had none (e.g. a model newer than the old list). */
export function repriceUnpriced(store: Store, table: PriceTable) {
  if (store.get('priceVersion') === table.version) return 0;
  let repriced = 0;
  store.transaction(() => {
    for (const row of store.unpriced()) {
      const price = calculate(row, table);
      if (price.costBasis !== 'unpriced') { store.replace({ ...row, ...price }); repriced++; }
    }
    store.set('priceVersion', table.version);
  });
  return repriced;
}
export async function collect(store: Store, config: Config, table: PriceTable) {
  let added = 0, invalid = 0, files = 0;
  repriceUnpriced(store, table);
  const roots: [Usage['tool'], string, string][] = [
    ['claude-code', config.claude_dir || join(homedir(), '.claude', 'projects'), '**/*.jsonl'],
    ['codex', config.codex_dir || join(homedir(), '.codex', 'sessions'), '**/rollout-*.jsonl'],
  ];
  const projects = new Map<string, ReturnType<typeof project>>();
  if (Date.now() - identityCache.created > 3600000) identityCache = { created: Date.now(), users: new Map() };
  const users = identityCache.users;
  // Config edits that change identity must apply at once, not after the cache expires.
  const identityConfig = [config.user, config.user_mode, config.user_hash_key, config.user_alias, config.allowed_email_domains, config.email_template];
  for (const [tool, root, pattern] of roots) {
    if (!existsSync(root)) continue;
    const context = toolContext(tool);
    for await (const relative of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true })) {
      files++;
      const path = join(root, relative);
      const key = 'cursor:' + createHash('sha256').update(path).digest('hex');
      let fd: number | undefined;
      try {
        const stat = statSync(path);
        const saved = store.get(key);
        let cursor: Cursor = saved ? JSON.parse(saved) : { offset: 0, state: readerState(), birth: stat.birthtimeMs };
        if (stat.size < cursor.offset || stat.birthtimeMs !== cursor.birth) cursor = { offset: 0, state: readerState(), birth: stat.birthtimeMs };
        if (stat.size === cursor.offset) continue; // nothing new in this file
        fd = openSync(path, 'r');
        const file = fd;
        // One transaction per file: rows and cursor are saved together (or not at all), and bulk import is fast.
        // On failure nothing is kept, so its counts are rolled back too.
        const before = { added, invalid };
        try { store.transaction(() => {
        let offset = cursor.offset;
        let pending = Buffer.alloc(0);
        let skipping = cursor.skipping ?? false; // inside an oversized line: drop bytes until its newline
        const chunk = Buffer.alloc(64 * 1024);
        while (offset < stat.size) {
          const size = readSync(file, chunk, 0, Math.min(chunk.length, stat.size - offset), offset);
          if (!size) break;
          offset += size;
          pending = Buffer.concat([pending, chunk.subarray(0, size)]);
          let end: number;
          while ((end = pending.indexOf(10)) >= 0) {
            const line = pending.subarray(0, end).toString('utf8');
            pending = pending.subarray(end + 1);
            cursor.offset += end + 1;
            if (skipping) { skipping = false; continue; }
            if (!line.trim()) continue;
            try {
              const usage = parseLine(line, tool, cursor.state, context.env);
              if (!usage) continue;
              if (context.subscription && ['anthropic', 'openai'].includes(usage.provider)) usage.provider = 'subscription';
              if (usage.provider === 'bedrock') usage.region = context.env.AWS_REGION;
              let p = projects.get(usage.cwd);
              if (!p) { p = project(usage.cwd, config); projects.set(usage.cwd, p); }
              const userKey = JSON.stringify([tool, usage.provider, usage.cwd, context.email, context.env.COSTLY_USER, context.env.AWS_PROFILE, identityConfig]);
              let u = users.get(userKey);
              if (!u) { u = identity(config, usage.provider, usage.cwd, undefined, context.email, context.env); users.set(userKey, u); }
              if (store.put({ ...usage, project: p.project, component: p.component, team: p.team, remote: p.remote, branch: p.branch, user: u.user, identitySource: u.source, ...calculate(usage, table) })) added++;
            } catch { invalid++; }
          }
          // A gigantic line must not exhaust memory or block the file: count it invalid and skip to its newline.
          if (pending.length > maxLine) {
            if (!skipping) invalid++;
            skipping = true; cursor.offset += pending.length; pending = Buffer.alloc(0);
          }
        }
        cursor.skipping = skipping || undefined;
        store.set(key, JSON.stringify(cursor));
        }, true); } catch (e) { ({ added, invalid } = before); throw e; }
      } catch { invalid++; } finally { if (fd !== undefined) closeSync(fd); }
    }
  }
  store.set('lastImport', new Date().toISOString());
  store.set('files', String(files)); store.set('invalid', String(invalid));
  return { added, invalid, files };
}
