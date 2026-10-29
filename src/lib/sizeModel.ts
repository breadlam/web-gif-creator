import raw from './sizeModel.json';

/*
 * GIF size model, fitted by tools/calibrate/calibrate.py against FFmpeg 5.1.4 (the
 * version inside ffmpeg.wasm). Size is linear in frame count:
 *
 *   bytes ≈ FILE_OVERHEAD + frames × (width × height × k + FRAME_OVERHEAD)
 *
 * where k (bytes per pixel per frame) = Σ coef_i × feature_i. The features are measured
 * by one cheap ffmpeg pass over the clip (see commands.ts: analysisArgs).
 */

export type Dither = 'sierra2_4a' | 'floyd_steinberg' | 'bayer' | 'none';
export type FeatureKind = 'bbox' | 'changed';

export interface Feature {
  kind: FeatureKind;
  threshold: number;
}

interface DitherModel {
  features: Feature[];
  coefsByHeight: Record<string, number[]>;
  margin: number;
  heldOut: { meanErr: number; utilization: number; overBudget: number; worstOverBudget: number };
}

interface ModelFile {
  ffmpeg: string;
  statsMode: string;
  clips: number;
  sources: number;
  models: Record<Dither, DitherModel>;
}

export const MODEL = raw as ModelFile;

export const DITHERS: { id: Dither; label: string }[] = [
  { id: 'sierra2_4a', label: 'Sierra 2-4A (ffmpeg default)' },
  { id: 'floyd_steinberg', label: 'Floyd–Steinberg' },
  { id: 'bayer', label: 'Bayer (ordered)' },
  { id: 'none', label: 'None' },
];

export const FILE_OVERHEAD = 1024; // header, global palette, loop extension, trailer
export const FRAME_OVERHEAD = 24; // graphic control ext, image descriptor, LZW framing
export const MAX_GIF_FPS = 50; // browsers show delays under 2 cs as 10 cs

export function featureKey(f: Feature): string {
  return `${f.kind}${f.threshold}`;
}

export function modelFor(dither: Dither): DitherModel {
  return MODEL.models[dither];
}

/** Coefficients at an output height, interpolated linearly between calibrated heights. */
export function coefsAt(dither: Dither, height: number): number[] {
  const byHeight = modelFor(dither).coefsByHeight;
  const hs = Object.keys(byHeight).map(Number).sort((a, b) => a - b);
  if (height <= hs[0]) return byHeight[hs[0]];
  if (height >= hs[hs.length - 1]) return byHeight[hs[hs.length - 1]];
  const i = hs.findIndex((h) => h >= height);
  const [h0, h1] = [hs[i - 1], hs[i]];
  const t = (height - h0) / (h1 - h0);
  return byHeight[h0].map((c, j) => c + (byHeight[h1][j] - c) * t);
}

export interface KEstimate {
  /** Best estimate of bytes per pixel per frame. */
  expected: number;
  /** Expected × margin: what the frame-rate calculation budgets for. */
  safe: number;
}

export function estimateK(dither: Dither, height: number, values: Record<string, number>): KEstimate {
  const m = modelFor(dither);
  const coefs = coefsAt(dither, height);
  const expected = m.features.reduce((sum, f, i) => sum + coefs[i] * (values[featureKey(f)] ?? 1), 0);
  return { expected, safe: expected * m.margin };
}

/** Frames the fps filter emits for a clip. */
export function frameCount(duration: number, fps: number): number {
  return Math.max(1, Math.ceil(duration * fps - 1e-6));
}

export function gifBytes(frames: number, width: number, height: number, k: number): number {
  return FILE_OVERHEAD + frames * (width * height * k + FRAME_OVERHEAD);
}

/**
 * Snap a frame rate to one GIF can show. GIF delays are whole centiseconds; with uniform
 * delays the rate is 100/d. Otherwise any rate works, and ffmpeg mixes delays to match.
 */
export function snapFps(fps: number, uniform: boolean): { fps: number; delayCs: number | null } {
  const f = Math.min(fps, MAX_GIF_FPS);
  if (uniform) {
    const delayCs = Math.max(2, Math.ceil(100 / f - 1e-9));
    return { fps: 100 / delayCs, delayCs };
  }
  return { fps: Math.floor(f * 100) / 100, delayCs: null };
}

export interface FpsPlan {
  fps: number;
  delayCs: number | null;
  frames: number;
  expectedBytes: number;
  safeBytes: number;
  limitedBy: 'budget' | 'source' | 'gif' | 'manual';
}

export function planFps(p: {
  budget: number;
  duration: number;
  width: number;
  height: number;
  k: KEstimate;
  sourceFps: number;
  uniform: boolean;
}): FpsPlan {
  const perFrame = p.width * p.height * p.k.safe + FRAME_OVERHEAD;
  const maxFrames = Math.max(1, Math.floor((p.budget - FILE_OVERHEAD) / perFrame));
  // frameCount(d, f) = ceil(d·f) ≤ maxFrames  ⇔  f ≤ maxFrames / d
  const budgetFps = maxFrames / p.duration;
  const sourceFps = p.sourceFps > 0 ? p.sourceFps : MAX_GIF_FPS;
  let limitedBy: 'budget' | 'source' | 'gif' = 'budget';
  let fps = budgetFps;
  if (sourceFps < fps) [fps, limitedBy] = [sourceFps, 'source'];
  if (MAX_GIF_FPS < fps) [fps, limitedBy] = [MAX_GIF_FPS, 'gif'];
  const snapped = snapFps(fps, p.uniform);
  const frames = frameCount(p.duration, snapped.fps);
  return {
    ...snapped,
    frames,
    expectedBytes: gifBytes(frames, p.width, p.height, p.k.expected),
    safeBytes: gifBytes(frames, p.width, p.height, p.k.safe),
    limitedBy,
  };
}
