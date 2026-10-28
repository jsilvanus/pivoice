import { createHash } from 'node:crypto';
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

export const SILERO_MODEL_URL = 'https://huggingface.co/skillsafe-ai/silero-vad/resolve/60b7ffa243625ebdc1070275a29f18c87843786a/silero_vad.onnx';
export const SILERO_MODEL_SHA256 = '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3';

const MODEL_PATH = process.env.PIVOICE_SILERO_MODEL_PATH || path.resolve('models/silero_vad.onnx');

const response = await fetch(SILERO_MODEL_URL, { redirect: 'follow' });
if (!response.ok) throw new Error(`Model download failed: HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
const hash = createHash('sha256').update(bytes).digest('hex');
if (hash !== SILERO_MODEL_SHA256) throw new Error(`Silero model SHA-256 mismatch: ${hash}`);
await mkdir(path.dirname(MODEL_PATH), { recursive: true });
const temporary = `${MODEL_PATH}.tmp`;
try {
  await writeFile(temporary, bytes, { flag: 'wx' });
  await rename(temporary, MODEL_PATH);
} catch (error) {
  await unlink(temporary).catch(() => {});
  throw error;
}
console.log(`Silero VAD model installed at ${MODEL_PATH} (${bytes.length} bytes; SHA-256 verified)`);
