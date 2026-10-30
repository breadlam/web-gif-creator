#!/usr/bin/env node
// End-to-end smoke test: serves the production build, drives a real Chromium through
// open → trim → (subtitles) → caption → exact preview → encode, and checks the GIF.
//
//   npm run build && npm run e2e -- [--video file]... [--chromium path] [--out dir]
//
// With no --video, a synthetic H.264 clip with an SRT track is generated (needs ffmpeg).
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const opt = (name) => argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []));
const out = resolve(opt('--out')[0] ?? join(root, 'test-results'));
mkdirSync(out, { recursive: true });

function findChromium() {
  if (opt('--chromium')[0]) return opt('--chromium')[0];
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const cache = join(homedir(), '.cache/ms-playwright');
  for (const d of existsSync(cache) ? readdirSync(cache).sort().reverse() : []) {
    for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const p = join(cache, d, sub);
      if (d.startsWith('chromium-') && existsSync(p)) return p;
    }
  }
  throw new Error('No Chromium found; pass --chromium or set CHROMIUM_PATH');
}

function syntheticVideo() {
  const srt = join(out, 'synthetic.srt');
  writeFileSync(srt, '1\n00:00:01,000 --> 00:00:03,500\nFirst subtitle line\n\n2\n00:00:04,000 --> 00:00:07,000\nSecond line\n');
  const mkv = join(out, 'synthetic.mkv');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-i', srt,
    '-t', '8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:s', 'srt', mkv]);
  return mkv;
}

async function serve() {
  if (!existsSync(join(root, 'dist/index.html'))) throw new Error('Run npm run build first');
  const port = 4173 + Math.floor(Math.random() * 500);
  const proc = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) return { url, proc };
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error('vite preview did not start');
}

async function runVideo(browser, url, video, index) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  const tag = `${index}-${video.split('/').pop().replace(/[^\w.-]+/g, '_')}`;
  const result = { video, errors };
  const idle = () => page.waitForFunction(() => !document.querySelector('.busy'), null, { timeout: 600_000 });
  const t0 = Date.now();
  try {
    await page.goto(url);
    await page.getByText('ffmpeg ready').waitFor({ timeout: 120_000 });
    await page.locator('input[type=file]').first().setInputFiles(video);
    await page.locator('.timeline, .unsupported').first().waitFor({ timeout: 120_000 });
    await idle();
    if (await page.locator('.unsupported').count()) {
      result.unsupported = (await page.locator('.unsupported p').textContent())?.trim();
      return result;
    }
    const subs = page.locator('.card', { hasText: 'Subtitles' });
    if (await subs.locator('.modes').count()) {
      // Subtitles are read on open; clip to the first line near the playhead and use "My style".
      result.track = await page.getByLabel('Subtitle track').evaluate((s) => s.selectedOptions[0]?.textContent.trim());
      await subs.locator('.browse li').first().getByRole('button', { name: 'Clip' }).click();
      await subs.locator('.modes label', { hasText: 'My style' }).click();
      result.subtitleLinesInClip = await subs.locator('ul:not(.browse) li').count();
      result.subtitlePreview = await page.locator('.frame .text.subtitle').textContent().catch(() => null);
    } else {
      const field = (label) => page.getByLabel(`Clip ${label.toLowerCase()} time`);
      await field('End').fill('0:06');
      await field('End').press('Tab');
      await field('Start').fill('0:02');
      await field('Start').press('Tab');
    }
    result.range = [await page.getByLabel('Clip start time').inputValue(), await page.getByLabel('Clip end time').inputValue()];

    await page.getByRole('button', { name: 'Add text' }).click();
    await page.locator('textarea').first().fill('E2E caption');
    await page.locator('.timeline').getByRole('button', { name: 'Go to start' }).click();
    await page.getByRole('button', { name: 'Preview exact frame' }).click();
    await page.locator('.exact img').waitFor({ timeout: 300_000 });
    await idle();

    await page.getByRole('button', { name: 'Make GIF' }).click();
    await page.locator('.result img').waitFor({ timeout: 900_000 });
    await idle();
    result.seconds = Math.round((Date.now() - t0) / 1000);
    Object.assign(result, await page.evaluate(async () => {
      const img = document.querySelector('.result img');
      const bytes = new Uint8Array(await (await fetch(img.src)).arrayBuffer());
      const dd = [...document.querySelectorAll('dl dd')].map((d) => d.textContent.trim());
      return {
        gifHeader: String.fromCharCode(...bytes.slice(0, 6)),
        gifBytes: bytes.length,
        width: bytes[6] | (bytes[7] << 8),
        height: bytes[8] | (bytes[9] << 8),
        plan: dd,
        error: document.querySelector('.error pre')?.textContent ?? null,
      };
    }));
    result.budgetBytes = 20e6;
    result.withinBudget = result.gifBytes <= result.budgetBytes;
  } catch (e) {
    result.failure = String(e);
    result.appError = await page.locator('.error pre').textContent().catch(() => null);
    result.logTail = await page.evaluate(() => document.querySelector('.log pre')?.textContent?.split('\n').slice(-15)).catch(() => null);
  } finally {
    await page.screenshot({ path: join(out, `${tag}.png`), fullPage: true }).catch(() => {});
    await page.close();
  }
  return result;
}

const videos = opt('--video').length ? opt('--video').map((v) => resolve(v)) : [syntheticVideo()];
const { url, proc } = await serve();
const browser = await chromium.launch({ executablePath: findChromium() });
let failed = false;
try {
  for (const [i, v] of videos.entries()) {
    const r = await runVideo(browser, url, v, i);
    console.log(JSON.stringify(r, null, 2));
    if (r.failure || (r.gifBytes !== undefined && (!r.withinBudget || r.gifHeader !== 'GIF89a'))) failed = true;
  }
} finally {
  await browser.close();
  proc.kill();
}
console.log(`screenshots: ${out}`);
process.exit(failed ? 1 : 0);
