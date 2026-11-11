#!/usr/bin/env bun
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { paths, loadConfig, deviceId } from '../core/config';
import { Store } from '../core/store';
import { project, identity } from '../core/attribution';
import { report, csv } from '../core/report';
import { push, pendingPoints } from '../collector/metrics';
import { run, start, stop, sync, running } from './daemon';
import { init } from './init';
import { setup, stack } from './setup';

const args = process.argv.slice(2);
let command = args.shift() || 'help';
const sub = args[0]?.startsWith('-') ? '' : args.shift();
if (command === 'daemon' && ['start', 'stop', 'status', 'run'].includes(sub || '')) {
  command = sub!; console.error(`Use costly ${command} instead of costly daemon ${command}.`);
}
const options: Record<string, string | boolean> = {};
for (let i = 0; i < args.length; i++) {
  const key = args[i].replace(/^--?/, '');
  if (!args[i].startsWith('-')) throw new Error('Unexpected argument.');
  options[key] = args[i + 1] && !args[i + 1].startsWith('-') ? args[++i] : true;
}
function date(value: string | boolean | undefined, fallback: number) {
  if (value === undefined) return fallback;
  const result = Date.parse(String(value));
  if (!Number.isFinite(result)) throw new Error('Dates must use ISO format, e.g. 2026-11-01.');
  return result;
}
async function main() {
  if (command === 'help' || command === '--help') { console.log('costly — early PoC, not released\nCommands: sync, report, export, project, whoami, doctor, status, setup, stack up|down, start, stop, run, init\nReports: --by project,model --from YYYY-MM-DD --to YYYY-MM-DD (exclusive)\nExport: --format csv|json --level daily|session --excel -o file\nInit: --project NAME [--component NAME] [--team NAME] [--yes] [--force] [--repo-only | --local]\nSetup: grafana --endpoint URL [--token-env NAME] [--instance-id ID]'); return; }
  if (command === 'init') { if (sub) throw new Error('Use costly init --project NAME.'); await init(options); return; }
  if (command === 'project') { console.log(JSON.stringify(project(process.cwd(), loadConfig()), null, 2)); return; }
  if (command === 'whoami') { console.log(JSON.stringify(identity(loadConfig(), 'unknown', process.cwd()), null, 2)); return; }
  if (command === 'stack') { await stack(sub || ''); return; }
  if (command === 'setup') { await setup(options); return; }
  if (command === 'run') { await run(); return; }
  if (command === 'stop') { await stop(); console.log('Daemon stopped.'); return; }
  const store = new Store(paths().db);
  try {
    if (command === 'sync') { console.log(JSON.stringify(await sync(store))); return; }
    if (command === 'start') {
      console.log(JSON.stringify(await sync(store)));
      const already = !!running();
      await start(resolve(process.argv[1]));
      console.log((already ? 'Daemon already running.' : 'Daemon started.') + ' Estimates (API equivalent, not subscription charges):');
      console.table(report(store.rows(), 'project'));
      console.log('To name a project, run costly init inside its repository.');
      if (process.stdin.isTTY && !loadConfig().endpoint) await setup(options);
      else if (!loadConfig().endpoint) console.log('Not connected; run costly setup. Collection continues.');
      return;
    }
    if (command === 'status' || command === 'doctor') {
      const rows = store.rows();
      const status = { running: !!running(), files: Number(store.get('files') || 0), records: rows.length, unpriced: rows.filter(r => r.costBasis === 'unpriced').length, unassigned: rows.filter(r => r.project === 'unassigned').length, unknownIdentity: rows.filter(r => r.identitySource === 'os').length, lastImport: store.get('lastImport') || null, lastPush: store.get('lastPush') || null, connection: store.get('connectionError') || (loadConfig().endpoint ? 'configured' : 'not connected'), invalidLines: Number(store.get('invalid') || 0), rejectedSeries: Number(store.get('rejectedSeries') || 0), pendingPoints: pendingPoints(store, loadConfig()) };
      console.log(JSON.stringify(status, null, 2));
      if (command === 'doctor') {
        const conflicts = [...new Set([process.cwd(), ...rows.map(r => r.cwd)])].filter(cwd => project(cwd, loadConfig()).markerRuleConflict);
        const problems = [
          ...conflicts.map(cwd => `Marker and local rule disagree in ${cwd}; marker wins. Run costly init to align them.`),
          status.unknownIdentity && `${status.unknownIdentity} records have no email (user "unknown:…"). Set user in config.toml or COSTLY_USER.`,
          status.unpriced && `${status.unpriced} records have no price; they are excluded from USD totals.`,
          status.unassigned && `${status.unassigned} records have no project. Run costly init in that project folder.`,
          status.rejectedSeries && `The backend refused ${status.rejectedSeries} series on the last push.`,
          status.connection !== 'configured' && `Connection: ${status.connection}`,
        ].filter(Boolean);
        console.log(problems.length ? problems.map(p => '- ' + p).join('\n') : 'No problems found.');
      }
      return;
    }
    if (command === 'push') { console.log(JSON.stringify(await push(store, loadConfig(), deviceId()))); return; }
    if (command !== 'report' && command !== 'export') throw new Error('Unknown command; use costly help.');
    const config = loadConfig();
    const mapping = new Map<string, ReturnType<typeof project>>();
    const rows = store.rows(date(options.from, 0), date(options.to, Number.MAX_SAFE_INTEGER)).map(r => {
      let p = mapping.get(r.cwd);
      if (!p) { p = project(r.cwd, config, process.env, r); mapping.set(r.cwd, p); }
      return { ...r, project: p.project, component: p.component, team: p.team };
    });
    if (command === 'report') { console.log('USD is estimated/API equivalent. Unpriced tokens are excluded from USD; ranges use UTC and an exclusive end.'); console.table(report(rows, String(options.by || 'project,model'))); return; }
    const level = options.level || 'daily';
    if (!['daily', 'session'].includes(String(level))) throw new Error('Export level must be daily or session.');
    const data = report(rows, level === 'session' ? 'session,project,component,user,tool,provider,model' : 'day,project,component,user,tool,provider,model');
    const format = options.format || 'json';
    if (!['csv', 'json'].includes(String(format))) throw new Error('Export format must be csv or json.');
    const output = format === 'csv' ? csv(data, !!options.excel) : JSON.stringify({ schema: 'costly.export.v1', currency: 'USD', cost: 'estimated/API-equivalent', data }, null, 2);
    if (options.o) writeFileSync(String(options.o), output, { flag: 'wx', mode: 0o600 }); else console.log(output);
  } finally { store.close(); }
}
try { await main(); } catch (e) { console.error(e instanceof Error ? e.message : 'Operation failed.'); process.exitCode = 1; }
