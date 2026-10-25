#!/usr/bin/env node
// `pivoice <command> [--server URL] [--token T] [--body JSON | --body-file PATH]`
// Commands are the OpenAPI operations (src/generated/commands.js, from openapi/openapi.yaml).
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { commands } from '../src/generated/commands.js';

const DEFAULT_SERVER = 'http://127.0.0.1:8095';

export function helpText() {
  const lines = [
    'Usage: pivoice <command> [options]',
    '',
    'Options:',
    '  --server URL       PiVoice base URL (env PIVOICE_SERVER, default ' + DEFAULT_SERVER + ')',
    '  --token TOKEN      Bearer token (env PIVOICE_TOKEN)',
    '  --body JSON        Request body',
    '  --body-file PATH   Request body from a file',
    '',
    'Commands:',
    ...commands.map((c) => `  ${c.command.padEnd(26)} ${c.method.padEnd(5)} ${c.path}  ${c.summary}`),
  ];
  return lines.join('\n') + '\n';
}

export function parseOptions(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[arg.slice(2)] = true;
    } else {
      out[arg.slice(2)] = next;
      i++;
    }
  }
  return out;
}

/** Runs one command. Returns the process exit code. Dependencies are injectable for tests. */
export async function run(argv, { fetchFn = globalThis.fetch, env = process.env, stdout = process.stdout, stderr = process.stderr, readFileFn = readFile } = {}) {
  const [name, ...rest] = argv;
  if (!name || name === 'help' || name === '--help') {
    stdout.write(helpText());
    return 0;
  }
  const spec = commands.find((c) => c.command === name);
  if (!spec) {
    stderr.write(`unknown command: ${name}\n${helpText()}`);
    return 2;
  }

  let opts;
  try {
    opts = parseOptions(rest);
  } catch (err) {
    stderr.write(`${err.message}\n`);
    return 2;
  }

  let path = spec.path;
  for (const param of spec.pathParams) {
    if (typeof opts[param] !== 'string') {
      stderr.write(`missing --${param}\n`);
      return 2;
    }
    path = path.replace(`{${param}}`, encodeURIComponent(opts[param]));
  }

  const headers = { accept: spec.streams ? 'text/event-stream' : 'application/json' };
  const token = typeof opts.token === 'string' ? opts.token : env.PIVOICE_TOKEN;
  if (spec.auth === 'bearer' && token) headers.authorization = `Bearer ${token}`;

  let body;
  if (spec.hasBody) {
    if (typeof opts.body === 'string') body = opts.body;
    else if (typeof opts['body-file'] === 'string') body = await readFileFn(opts['body-file'], 'utf8');
    else {
      stderr.write('this command needs --body JSON or --body-file PATH\n');
      return 2;
    }
    headers['content-type'] = 'application/json';
  }

  const server = String(typeof opts.server === 'string' ? opts.server : env.PIVOICE_SERVER ?? DEFAULT_SERVER).replace(/\/$/, '');
  const res = await fetchFn(server + path, { method: spec.method, headers, body });

  if (spec.streams) {
    for await (const chunk of res.body) stdout.write(chunk);
    return res.ok ? 0 : 1;
  }
  const text = await res.text();
  let printable = text;
  try {
    printable = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // not JSON: print as is
  }
  (res.ok ? stdout : stderr).write(printable + '\n');
  return res.ok ? 0 : 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2));
}
