import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { isDeepStrictEqual } from 'node:util';
import { command, normalizeRemote, matchingRule } from '../core/attribution';
import { paths } from '../core/config';
import type { Config } from '../core/types';

type Options = Record<string, string | boolean>;
const labels = ['project', 'component', 'team'] as const;
const read = (path: string) => existsSync(path) ? readFileSync(path, 'utf8') : '';
export function initTarget(cwd: string) {
  const root = resolve(command(['git', 'rev-parse', '--show-toplevel'], cwd) || cwd);
  const remote = normalizeRemote(command(['git', 'remote', 'get-url', 'upstream'], root) || command(['git', 'remote', 'get-url', 'origin'], root));
  return { root, remote, branch: command(['git', 'branch', '--show-current'], root) };
}
export function validateLabel(value: string) {
  if (!/^[A-Za-z0-9_.-]{1,63}$/.test(value)) throw new Error('Names must contain 1–63 letters, digits, dots, underscores or hyphens.');
  return value;
}
// Edit only owned scalar assignments. Validate the full parsed result before writing.
export function patchFields(text: string, values: Record<string, string>) {
  const end = text.search(/^\s*\[/m);
  let head = end < 0 ? text : text.slice(0, end);
  const tail = end < 0 ? '' : text.slice(end);
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  for (const [key, value] of Object.entries(values)) {
    const pattern = new RegExp('^([ \\t]*' + key + '[ \\t]*=[ \\t]*)("(?:[^"\\\\]|\\\\.)*"|\'[^\']*\')([ \\t]*(?:#[^\\r\\n]*)?)$', 'm');
    if (pattern.test(head)) head = head.replace(pattern, (_, prefix, _old, suffix) => prefix + JSON.stringify(value) + suffix);
    else head += (head && !head.endsWith('\n') ? nl : '') + `${key} = ${JSON.stringify(value)}${nl}`;
  }
  return head + tail;
}
export function markerText(text: string, values: Record<string, string>) {
  const before = Bun.TOML.parse(text);
  const result = patchFields(text, values);
  if (!isDeepStrictEqual(Bun.TOML.parse(result), { ...before, ...values })) throw new Error('Cannot safely edit marker; simplify its label assignments first.');
  return result;
}
export function ruleText(text: string, target: ReturnType<typeof initTarget>, values: Record<string, string>) {
  const before = Bun.TOML.parse(text) as Config;
  const key = target.remote ? 'match_remote' : 'match_path';
  const value = target.remote || target.root.replace(/\\/g, '/');
  const rules = before.rule || [];
  const indexes = rules.flatMap((r, i) => r[key] === value && !r.match_branch && !(key === 'match_remote' ? r.match_path : r.match_remote) ? [i] : []);
  if (indexes.length > 1) throw new Error('Multiple rules match this repository; consolidate them before init.');
  const index = indexes[0];
  const updated = { ...(index === undefined ? {} : rules[index]), [key]: value, ...values };
  let result: string;
  if (index === undefined) result = text + (text.endsWith('\n') || !text ? '' : '\n') + '\n[[rule]]\n' + patchFields('', updated as Record<string, string>);
  else {
    const headers = [...text.matchAll(/^[ \t]*\[\[rule\]\][ \t]*(?:#[^\r\n]*)?\r?$/gm)];
    if (headers.length !== rules.length) throw new Error('Cannot safely edit rule layout; use standard [[rule]] headers.');
    const start = headers[index].index! + headers[index][0].length;
    const rest = text.slice(start);
    const next = rest.search(/^[ \t]*\[/m);
    const end = next < 0 ? text.length : start + next;
    result = text.slice(0, start) + patchFields(text.slice(start, end), values) + text.slice(end);
  }
  const expected = structuredClone(before);
  expected.rule = [...rules];
  if (index === undefined) expected.rule.push(updated as any); else expected.rule[index] = updated as any;
  if (!isDeepStrictEqual(Bun.TOML.parse(result), expected)) throw new Error('Cannot safely edit config; existing content was left unchanged.');
  return result;
}
export async function init(options: Options, cwd = process.cwd()) {
  const allowed = ['project', 'component', 'team', 'yes', 'force', 'repo-only', 'local'];
  for (const key of Object.keys(options)) if (!allowed.includes(key)) throw new Error(`Unknown init option: --${key}`);
  if (options.local && options['repo-only']) throw new Error('--local and --repo-only cannot be combined.');
  for (const key of labels) if (options[key] !== undefined && typeof options[key] !== 'string') throw new Error(`--${key} requires a name.`);
  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY;
  if (!interactive && !options.project) throw new Error('Non-interactive init requires --project NAME.');
  const target = initTarget(cwd);
  const marker = join(target.root, '.costly.toml');
  const config = paths().config;
  const oldMarker = read(marker), oldConfig = read(config);
  const previous = Bun.TOML.parse(oldMarker) as Record<string, string>;
  const rule = matchingRule(target.root, target.remote, target.branch, Bun.TOML.parse(oldConfig) as Config);
  const suggested = previous.project || rule?.project || target.remote.split('/').pop() || basename(target.root);
  const rl = interactive && !options.yes ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  try {
    const values: Record<string, string> = {};
    for (const key of labels) {
      const fallback = key === 'project' ? suggested : previous[key] || rule?.[key] || (key === 'component' ? target.remote.split('/').pop() || basename(target.root) : '');
      const value = options[key] as string | undefined ?? (rl ? (await rl.question(`${key} [${fallback}]: `)).trim() || fallback : key === 'project' ? suggested : previous[key] || rule?.[key] || '');
      if (value) values[key] = validateLabel(value);
      else if (key === 'project') validateLabel(value);
    }
    if (!options.local && existsSync(marker) && !options.force) {
      console.log('Existing marker:', JSON.stringify(previous));
      if (!rl || !/^y(es)?$/i.test((await rl.question('Overwrite project labels? [y/N]: ')).trim())) throw new Error('Marker unchanged; use --force to overwrite it.');
    }
    // Prepare and validate both files before either write.
    const nextMarker = options.local ? undefined : markerText(oldMarker || '# costly project marker — https://github.com/msiemieniaka/costly-cli\n', values);
    const nextConfig = options['repo-only'] ? undefined : ruleText(oldConfig, target, values);
    if (read(marker) !== oldMarker || read(config) !== oldConfig) throw new Error('Files changed during init; retry.');
    if (nextConfig !== undefined) { mkdirSync(dirname(config), { recursive: true }); writeFileSync(config, nextConfig, { mode: 0o600 }); console.log(`Rule saved in ${config}`); }
    if (nextMarker !== undefined) { writeFileSync(marker, nextMarker); console.log(`Marker saved in ${marker}\nCommit .costly.toml so your team uses the same project.`); }
    console.log('Check: costly project\nStart collection: costly start');
  } finally { rl?.close(); }
}
