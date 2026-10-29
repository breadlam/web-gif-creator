import { buildOverlayAss, disableCues, type Cue, type TextOverlay } from './ass';
import {
  analysisArgs, dumpFontArgs, encodeArgs, extractSubtitlesArgs, featureFile, FONTS_DIR,
  previewFrameArgs, stillFrameArgs, subtitleFile, WORK, type Clip, type TextLayers,
} from './commands';
import { engine, type ExecResult } from './engine';
import { fontNames, remapMissingFonts } from './fontNames';
import { bundledFonts } from './fonts';
import { featureValue, parseFrameProgress, parseTimeProgress } from './metadata';
import { outputWidth, parseProbe, type MediaInfo } from './probe';
import {
  estimateK, frameCount, gifBytes, modelFor, planFps, snapFps,
  type Dither, type FpsPlan, type KEstimate,
} from './sizeModel';
import { applyOverrides, buildSubtitleAss, overlapping, type SubtitleMode, type SubtitleStyle } from './subtitles';

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
  /** Every name libass can match a bundled or embedded font by. */
  names: string[];
  /** The embedded fonts' bytes, so the UI can offer them for captions too. */
  files: Uint8Array[];
}

/** Bundled fonts plus any fonts embedded in the file (MKV attachments, used by ASS styles). */
export async function loadFonts(input: string, info: MediaInfo): Promise<LoadedFonts> {
  if (!bundledNames) {
    const files = [...new Set(bundledFonts().map((f) => f.file!))];
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
  const files: Uint8Array[] = [];
  if (info.fonts.length === 0) return { embedded: 0, names, files };
  await engine.exec(dumpFontArgs(input, info.fonts));
  const dumped = (await engine.list(FONTS_DIR)).filter((n) => n.startsWith('attachment-'));
  for (const name of dumped) {
    const bytes = await engine.read(`${FONTS_DIR}/${name}`);
    // Re-register through write() so the font survives an ffmpeg reload after cancel.
    await engine.write(`${FONTS_DIR}/${name}`, bytes);
    names.push(...fontNames(bytes));
    files.push(bytes);
  }
  return { embedded: dumped.length, names, files };
}

/**
 * Convert every text subtitle track to ASS, keyed by stream index. One pass over the
 * file (demux only), so switching tracks afterwards is instant.
 */
export async function extractSubtitles(input: string, info: MediaInfo, progress: Progress): Promise<Record<number, string>> {
  const tracks = info.subtitles.filter((t) => t.text);
  if (tracks.length === 0) return {};
  const r = await engine.exec(extractSubtitlesArgs(input, tracks), (l) => {
    const t = parseTimeProgress(l);
    if (t !== null && info.duration > 0) progress(Math.min(1, t / info.duration), 'Reading subtitles');
  });
  const out: Record<number, string> = {};
  for (const t of tracks) {
    const path = subtitleFile(t.index);
    if (!(await engine.exists(path))) continue;
    out[t.index] = await engine.readText(path);
    await engine.remove(path);
  }
  if (Object.keys(out).length === 0 && r.code !== 0) throw new FfmpegError('Reading subtitles', r);
  return out;
}

export interface SubtitleSettings {
  mode: SubtitleMode;
  /** The selected track as ASS, for 'original' mode. */
  ass: string | null;
  cues: Cue[];
  /** ASS line numbers of cues to leave out. */
  disabled: Set<number>;
  /** Edited text, by ASS line number. */
  overrides: Record<number, string>;
  style: SubtitleStyle;
}

export interface TextSettings {
  subtitles: SubtitleSettings;
  overlays: TextOverlay[];
  /** Font names available to libass; subtitle styles using others fall back to Noto Sans. */
  fonts: string[];
}

export async function writeTextLayers(t: TextSettings, width: number, height: number, range: [number, number]): Promise<TextLayers> {
  const layers: TextLayers = {};
  const s = t.subtitles;
  if (s.mode === 'original' && s.ass) {
    layers.subtitles = `${WORK}/subtitles.ass`;
    const ass = applyOverrides(disableCues(s.ass, s.disabled), s.overrides);
    await engine.write(layers.subtitles, remapMissingFonts(ass, t.fonts, 'Noto Sans'));
  } else if (s.mode === 'custom') {
    const cues = overlapping(s.cues, range[0], range[1]).filter((c) => !s.disabled.has(c.line));
    if (cues.length) {
      layers.subtitles = `${WORK}/subtitles.ass`;
      await engine.write(layers.subtitles, buildSubtitleAss(cues, s.overrides, s.style, width, height));
    }
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
  return { input: job.input, video: job.info.videoIndex, start: job.start, duration: job.end - job.start, height: job.height };
}

/** Make a user's font file available to libass. Returns the names it can be matched by. */
export async function addFontFile(bytes: Uint8Array, name: string): Promise<string[]> {
  await engine.write(`${FONTS_DIR}/${name}`, bytes);
  return fontNames(bytes);
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
        ...base, ...snapped, frames, limitedBy: opts.manualFps > source ? 'source' : 'manual',
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
export async function previewFrame(job: Pick<Job, 'input' | 'info' | 'height' | 'layers'>, time: number): Promise<Blob> {
  const out = `${WORK}/preview.png`;
  const r = await engine.exec(previewFrameArgs(job.input, job.info.videoIndex, time, job.height, job.layers, out));
  if (r.code !== 0) throw new FfmpegError('Rendering the preview frame', r);
  const png = await engine.read(out);
  await engine.remove(out);
  return new Blob([png as BlobPart], { type: 'image/png' });
}

/** Still frame for files the browser's <video> element can't play. */
export async function stillFrame(input: string, video: number, time: number, height = 360): Promise<Blob> {
  const out = `${WORK}/still.jpg`;
  const r = await engine.exec(stillFrameArgs(input, video, time, height, out));
  if (r.code !== 0) throw new FfmpegError('Rendering a still frame', r);
  const jpg = await engine.read(out);
  await engine.remove(out);
  return new Blob([jpg as BlobPart], { type: 'image/jpeg' });
}
