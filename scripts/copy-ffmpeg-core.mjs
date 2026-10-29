// Copy the single-threaded ffmpeg.wasm core into public/ so it is served from our own
// origin (GitHub Pages can't send COOP/COEP headers, so the -mt core isn't an option).
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules/@ffmpeg/core/dist/esm');
const dest = join(root, 'public/ffmpeg-core');
mkdirSync(dest, { recursive: true });
for (const f of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
  const from = join(src, f);
  const to = join(dest, f);
  if (!existsSync(to) || statSync(to).size !== statSync(from).size) copyFileSync(from, to);
}
