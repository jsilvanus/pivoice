import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const install = spawnSync(npm, ['install', '--no-save', '--package-lock=false', 'onnxruntime-node'], {
  cwd: root,
  stdio: 'inherit',
});
if (install.status !== 0) process.exit(install.status ?? 1);
const model = spawnSync(process.execPath, ['scripts/download-silero-model.js'], {
  cwd: root,
  stdio: 'inherit',
});
process.exit(model.status ?? 1);
