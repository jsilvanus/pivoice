import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
// pnpm has no --no-save: install the runtime, then put package.json and the lockfile back
// so onnxruntime-node stays optional (src/silero-vad.js falls back to the energy gate without it).
const kept = ['package.json', 'pnpm-lock.yaml']
  .filter((f) => existsSync(path.join(root, f)))
  .map((f) => [f, readFileSync(path.join(root, f))]);
let install;
try {
  install = spawnSync(pnpm, ['add', 'onnxruntime-node'], { cwd: root, stdio: 'inherit' });
} finally {
  for (const [f, content] of kept) writeFileSync(path.join(root, f), content);
}
if (install.status !== 0) process.exit(install.status ?? 1);
const model = spawnSync(process.execPath, ['scripts/download-silero-model.js'], {
  cwd: root,
  stdio: 'inherit',
});
process.exit(model.status ?? 1);
