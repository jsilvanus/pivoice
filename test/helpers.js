import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore } from '../src/config.js';

/** A child process stand-in: stdout/stderr/stdin are streams the test drives. */
export class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  killed = [];
  kill(signal) {
    this.killed.push(signal);
    return true;
  }
  exit(code = 1) {
    this.emit('exit', code, null);
  }
}

/** spawn() replacement that records every child it creates. */
export function fakeSpawn() {
  const children = [];
  const spawn = (command, args, options) => {
    const child = new FakeChild();
    Object.assign(child, { command, args, options });
    children.push(child);
    return child;
  };
  spawn.children = children;
  return spawn;
}

export async function waitFor(check, timeoutMs = 2000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

export async function tempStore(config = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pivoice-test-'));
  const store = new ConfigStore(path.join(dir, 'config.json'));
  if (Object.keys(config).length) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(dir, 'config.json'), JSON.stringify(config));
  }
  await store.load();
  return { store, dir };
}

/** Minimal Response-like object for fake fetch. */
export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
