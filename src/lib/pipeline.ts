import { buildOverlayAss, disableCues, type TextOverlay } from './ass';
import {
  analysisArgs, dumpFontArgs, encodeArgs, extractSubtitleArgs, featureFile, FONTS_DIR,
  previewFrameArgs, stillFrameArgs, WORK, type Clip, type TextLayers,
} from './commands';
import { engine, type ExecResult } from './engine';
import { fontNames, remapMissingFonts } from './fontNames';
import { FONTS } from './fonts';
import { featureValue, parseFrameProgress, parseTimeProgress } from './metadata';
import { outputWidth, parseProbe, type MediaInfo, type SubtitleTrack } from './probe';
import {
  estimateK, frameCount, gifBytes, modelFor, planFps, snapFps,
  type Dither, type FpsPlan, type KEstimate,
} from './sizeModel';

export type Progress = (fraction: number | null, label: string) => void;

export class FfmpegError extends Error {
  constructor(what: string, result: ExecResult) {
    const tail = result.lines.filter((l) => !/^\s*(frame|size)=/.test(l)).slice(-6).join('\n');
    super(`${what} failed (ffmpeg exit code ${result.code}).\n${tail}`);
  }
}

export async function openFile(file: File): Promise<{ info: MediaInfo; input: string }> {
  const input = await engine.setInput(file);
  const out = `${WORK}/probe.json`;
  const r = await engine.ffprobe(['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-o', out, input]);
  // The 0.12 core only sets ffprobe's exit code on failure paths (success returns -1),
  // so judge by whether it wrote the JSON.
  if (!(await engine.exists(out))) throw new FfmpegError('Reading the video', r);
  const info = parseProbe(JSON.parse(await engine.readText(out)));
  await engine.remove(out);
  return { info, input };
}

let bundledNames: string[] | null = null;

export interface LoadedFonts {
  /** Number of fonts embedded in the file. */
  embedded: number;
  /** Every name libass can match a font by. */
  names: string[];
}

/** Bundled fonts plus any fonts embedded in the file (MKV attachments, used by ASS styles). */
export async function loadFonts(input: string, info: MediaInfo): Promise<LoadedFonts> {
  if (!bundledNames) {
    const files = [...new Set(FONTS.map((f) => f.file))];
    const loaded = await Promise.all(files.map(async (file) => {
      const res = await fetch(new URL(`fonts/${file}`, document.baseURI));
      if (!res.ok) throw new Error(`Couldn't load font ${file}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      await engine.write(`${FONTS_DIR}/${file}`, bytes);
      return fontNames(bytes);
    }));
    bundledNames = loaded.flat();
  }
  for (const name of await engine.list(FONTS_DIR)) {
    if (name.startsWith('attachment-')) await engine.remove(`${FONTS_DIR}/${name}`);
  }
  const names = [...bundledNames];
  if (info.fonts.length === 0) return { embedded: 0, names };
  await engine.exec(dumpFontArgs(input, info.fonts));
  const dumped = (await engine.list(FONTS_DIR)).filter((n) => n.startsWith('attachment-'));
  for (const name of dumped) {
    const bytes = await engine.read(`${FONTS_DIR}/${name}`);
    // Re-register through write() so the font survives an ffmpeg reload after cancel.
    await engine.write(`${FONTS_DIR}/${name}`, bytes);
    names.push(...fontNames(bytes));
  }
  return { embedded: dumped.length, names };
}

/** Convert a text subtitle track to ASS. Reads through the whole file (demux only). */
export async function extractSubtitles(input: string, info: MediaInfo, track: SubtitleTrack, progress: Progress): Promise<string> {
  const out = `${WORK}/track-${track.index}.ass`;
  const r = await engine.exec(extractSubtitleArgs(input, track.index, track.codec, out), (l) => {
    const t = parseTimeProgress(l);
    if (t !== null && info.duration > 0) progress(Math.min(1, t / info.duration), 'Extracting subtitles');
  });
  if (r.code !== 0) throw new FfmpegError('Extracting subtitles', r);
  const text = await engine.readText(out);
  await engine.remove(out);
  return text;
}

export interface TextSettings {
  subtitleAss: string | null;
  disabledCues: Set<number>;
  overlays: TextOverlay[];
  /** Font names available to libass; subtitle styles using others fall back to Noto Sans. */
  fonts: string[];
}

export async function writeTextLayers(t: TextSettings, width: number, height: number): Promise<TextLayers> {
  const layers: TextLayers = {};
  if (t.subtitleAss) {
    layers.subtitles = `${WORK}/subtitles.ass`;
    await engine.write(layers.subtitles, remapMissingFonts(disableCues(t.subtitleAss, t.disabledCues), t.fonts, 'Noto Sans'));
  }
  const active = t.overlays.filter((o) => o.text.trim() && o.end > o.start);
  if (active.length) {
    layers.overlays = `${WORK}/overlays.ass`;
    await engine.write(layers.overlays, buildOverlayAss(active, width, height));
  }
  return layers;
}

export interface Job {
  input: string;
  info: MediaInfo;
  start: number;
  end: number;
  height: number;
  dither: Dither;
  layers: TextLayers;
}

function clipOf(job: Job): Clip {
  return { input: job.input, start: job.start, duration: job.end - job.start, height: job.height };
}

/** Measure the size-model features for a clip at a given frame rate. */
export async function measure(job: Job, fps: number, progress: Progress): Promise<Record<string, number>> {
  const features = modelFor(job.dither).features;
  const clip = clipOf(job);
  const total = frameCount(clip.duration, fps);
  const r = await engine.exec(analysisArgs(clip, fps, job.layers, features), (l) => {
    const n = parseFrameProgress(l);
    if (n !== null) progress(Math.min(1, n / total), `Analysing motion at ${fps.toFixed(2)} fps`);
  });
  if (r.code !== 0) throw new FfmpegError('Analysing the clip', r);
  const width = outputWidth(job.info, job.height);
  const values: Record<string, number> = {};
  for (const f of features) {
    values[`${f.kind}${f.threshold}`] = featureValue(f, await engine.readText(featureFile(f)), width, job.height, total);
    await engine.remove(featureFile(f));
  }
  return values;
}

export interface Plan extends FpsPlan {
  width: number;
  height: number;
  budget: number;
  k: KEstimate;
  features: Record<string, number>;
  analysedAt: number;
}

export interface PlanOptions {
  budget: number;
  uniform: boolean;
  /** Fixed frame rate; when null the maximum rate for the budget is calculated. */
  manualFps: number | null;
}

/**
 * Calculate the frame rate. Features depend mildly on frame rate (higher rates mean
 * smaller changes between frames), so measure near the rate being planned: once at a
 * first guess, and again at the result if it lands far from the guess.
 */
export async function planClip(job: Job, opts: PlanOptions, progress: Progress): Promise<Plan> {
  const width = outputWidth(job.info, job.height);
  const duration = job.end - job.start;
  const source = job.info.fps || 25;
  const make = (features: Record<string, number>, analysedAt: number): Plan => {
    const k = estimateK(job.dither, job.height, features);
    const base = { width, height: job.height, budget: opts.budget, k, features, analysedAt };
    if (opts.manualFps !== null) {
      const snapped = snapFps(Math.min(opts.manualFps, source), opts.uniform);
      const frames = frameCount(duration, snapped.fps);
      return {
        ...base, ...snapped, frames, limitedBy: 'manual',
        expectedBytes: gifBytes(frames, width, job.height, k.expected),
        safeBytes: gifBytes(frames, width, job.height, k.safe),
      };
    }
    return { ...base, ...planFps({ budget: opts.budget, duration, width, height: job.height, k, sourceFps: source, uniform: opts.uniform }) };
  };
  const first = opts.manualFps ?? Math.min(source, 15);
  let plan = make(await measure(job, first, progress), first);
  const ratio = plan.fps / first;
  if (opts.manualFps === null && (ratio < 0.75 || ratio > 1.33)) {
    plan = make(await measure(job, plan.fps, progress), plan.fps);
  }
  return plan;
}

export async function encodeGif(job: Job, fps: number, progress: Progress): Promise<Uint8Array> {
  const clip = clipOf(job);
  const total = frameCount(clip.duration, fps);
  const out = `${WORK}/output.gif`;
  let decoded = 0;
  progress(0, 'Decoding and building palette');
  const r = await engine.exec(encodeArgs(clip, fps, job.dither, job.layers, out), (l) => {
    const n = parseFrameProgress(l);
    if (n === null) return;
    decoded = n;
    if (decoded < total) progress(Math.min(1, decoded / total) * 0.6, 'Decoding and building palette');
    else progress(null, 'Dithering and writing GIF');
  });
  if (r.code !== 0) throw new FfmpegError('Encoding the GIF', r);
  const gif = await engine.read(out);
  await engine.remove(out);
  return gif;
}

/** Render one frame through the real scale + text pipeline. */
export async function previewFrame(job: Pick<Job, 'input' | 'height' | 'layers'>, time: number): Promise<Blob> {
  const out = `${WORK}/preview.png`;
  const r = await engine.exec(previewFrameArgs(job.input, time, job.height, job.layers, out));
  if (r.code !== 0) throw new FfmpegError('Rendering the preview frame', r);
  const png = await engine.read(out);
  await engine.remove(out);
  return new Blob([png as BlobPart], { type: 'image/png' });
}

/** Still frame for files the browser's <video> element can't play. */
export async function stillFrame(input: string, time: number, height = 360): Promise<Blob> {
  const out = `${WORK}/still.jpg`;
  const r = await engine.exec(stillFrameArgs(input, time, height, out));
  if (r.code !== 0) throw new FfmpegError('Rendering a still frame', r);
  const jpg = await engine.read(out);
  await engine.remove(out);
  return new Blob([jpg as BlobPart], { type: 'image/jpeg' });
}
