import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generate, buildCommands } from '../scripts/generate-cli.js';
import { commands } from '../src/generated/commands.js';
import { ROUTES } from '../src/server.js';
import { run } from '../cli/pivoice.js';
import { parse } from 'yaml';
import { readFile } from 'node:fs/promises';
import { SPEC_FILE } from '../scripts/generate-cli.js';

const sink = () => {
  const chunks = [];
  return { write: (s) => chunks.push(Buffer.from(s).toString('utf8')), text: () => chunks.join('') };
};

test('the committed CLI table matches the OpenAPI spec', async () => {
  await generate({ check: true });
});

test('every non-probe operation in the spec has a server route, and the reverse', async () => {
  const spec = parse(await readFile(SPEC_FILE, 'utf8'));
  const specOps = buildCommands(spec).map((c) => c.operationId).filter((id) => !['getHealth', 'getReady'].includes(id));
  assert.deepEqual([...specOps].sort(), Object.values(ROUTES).sort());
});

test('the CLI sends the bearer token to the chosen server and prints the JSON answer', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ capture: { running: false } }), { status: 200 });
  };
  const out = sink();
  const code = await run(['get-status', '--server', 'http://pi.lan:8095', '--token', 't0k'], { fetchFn, stdout: out, stderr: sink() });
  assert.equal(code, 0);
  assert.equal(calls[0].url, 'http://pi.lan:8095/api/v1/status');
  assert.equal(calls[0].init.headers.authorization, 'Bearer t0k');
  assert.match(out.text(), /"running": false/);
});

test('a command that needs a body refuses without one', async () => {
  const err = sink();
  assert.equal(await run(['update-config'], { fetchFn: async () => new Response('{}'), stdout: sink(), stderr: err }), 2);
  assert.match(err.text(), /--body/);
});

test('--body is sent as JSON', async () => {
  let sent;
  const fetchFn = async (url, init) => {
    sent = init;
    return new Response('{}', { status: 200 });
  };
  await run(['update-config', '--body', '{"auditor":{"language":"sv"}}'], { fetchFn, stdout: sink(), stderr: sink(), env: { PIVOICE_TOKEN: 'x' } });
  assert.equal(sent.method, 'PUT');
  assert.equal(sent.body, '{"auditor":{"language":"sv"}}');
  assert.equal(sent.headers['content-type'], 'application/json');
});

test('the event stream is copied to stdout as it arrives', async () => {
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('event: capture\ndata: {}\n\n'));
      c.close();
    },
  });
  const out = sink();
  const code = await run(['stream-transcription-events'], { fetchFn: async () => new Response(body, { status: 200 }), stdout: out, stderr: sink() });
  assert.equal(code, 0);
  assert.equal(out.text(), 'event: capture\ndata: {}\n\n');
  assert.equal(commands.find((c) => c.command === 'stream-transcription-events').streams, true);
});

test('unknown commands exit 2 and help lists the spec', async () => {
  const err = sink();
  assert.equal(await run(['frobnicate'], { stdout: sink(), stderr: err }), 2);
  const out = sink();
  assert.equal(await run(['help'], { stdout: out, stderr: sink() }), 0);
  assert.match(out.text(), /update-config\s+PUT\s+\/api\/v1\/config/);
});
