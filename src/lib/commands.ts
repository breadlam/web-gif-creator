// ffmpeg argument builders. The GIF chain must stay identical to
// tools/calibrate/calibrate.py, or the size model no longer applies.
import type { Dither, Feature } from './sizeModel';
import { featureKey } from './sizeModel';
import { ffTime } from './time';

export const WORK = '/work';

/**
 * Prefix for every ffmpeg call. The wasm module keeps FFmpeg's globals between calls, so a
 * log level set by one command (e.g. ffprobe -v error) would silence the next ones,
 * including the "frame=" progress lines.
 */
const BASE = ['-hide_banner', '-loglevel', 'info'];
export const FONTS_DIR = '/fonts';

export interface Clip {
  input: string;
  start: number;
  duration: number;
  height: number;
}

/** ASS files to burn in, already written to the ffmpeg filesystem. */
export interface TextLayers {
  subtitles?: string;
  overlays?: string;
}

const PALETTEUSE: Record<Dither, string> = {
  sierra2_4a: 'dither=sierra2_4a',
  floyd_steinberg: 'dither=floyd_steinberg',
  bayer: 'dither=bayer:bayer_scale=2',
  none: 'dither=none',
};

export function scaleFilter(height: number): string {
  return `scale=w='trunc(${height}*dar/2)*2':h=${height}:flags=lanczos,setsar=1`;
}

/**
 * Burn-in filters. Input seeking (-ss before -i) resets timestamps to 0, but the ASS
 * files use source-video times, so shift PTS while libass renders. The subtitles filter
 * truncates the frame time to whole milliseconds, so a frame exactly at a line's start
 * could land 1 ms early and be skipped; the extra 1 ms prevents that.
 */
export function textFilters(start: number, layers: TextLayers): string[] {
  const subs = [layers.subtitles, layers.overlays].filter((p): p is string => !!p);
  if (subs.length === 0) return [];
  return [
    `setpts=PTS+${ffTime(start + 0.001)}/TB`,
    ...subs.map((p) => `subtitles=filename=${p}:fontsdir=${FONTS_DIR}`),
    'setpts=PTS-STARTPTS',
  ];
}

/**
 * Text is burned in before the fps filter, while timestamps are still in the source's
 * fine-grained time base. After fps the time base is one frame (e.g. 60 ms), and
 * rounding there can shift a frame's time from a line's start to just before it.
 */
function sourceChain(clip: Clip, fps: number, layers: TextLayers): string {
  return [scaleFilter(clip.height), ...textFilters(clip.start, layers), `fps=${fpsArg(fps)}`].join(',');
}

export function fpsArg(fps: number): string {
  return String(Math.round(fps * 1e6) / 1e6);
}

function seekArgs(clip: Clip): string[] {
  return ['-ss', ffTime(clip.start), '-t', ffTime(clip.duration), '-i', clip.input];
}

export function featureFile(f: Feature): string {
  return `${WORK}/feature-${featureKey(f)}.txt`;
}

/** One pass that measures every feature the size model needs, without encoding. */
export function analysisArgs(clip: Clip, fps: number, layers: TextLayers, features: Feature[]): string[] {
  const diff = `${sourceChain(clip, fps, layers)},format=yuv420p,tblend=all_mode=difference`;
  const labels = features.map((_, i) => `f${i}`);
  const split = features.length > 1 ? `,split=${features.length}${labels.map((l) => `[${l}]`).join('')}` : `[${labels[0]}]`;
  const branches = features.map((f, i) => {
    const measure =
      f.kind === 'bbox'
        ? `bbox=min_val=${f.threshold},metadata=mode=print:file=${featureFile(f)}`
        : `lutyuv=y='if(gt(val,${f.threshold}),255,0)',signalstats,` +
          `metadata=mode=print:key=lavfi.signalstats.YAVG:file=${featureFile(f)}`;
    return `[${labels[i]}]${measure}[o${i}]`;
  });
  const outputs = features.flatMap((_, i) => ['-map', `[o${i}]`, '-f', 'null', '-']);
  return [...BASE, ...seekArgs(clip), '-filter_complex', [`[0:v]${diff}${split}`, ...branches].join(';'), ...outputs];
}

/**
 * Encode the GIF. A null output is mapped first so ffmpeg's "frame=" counter reports
 * decoding progress while palettegen is still collecting statistics.
 */
export function encodeArgs(clip: Clip, fps: number, dither: Dither, layers: TextLayers, out: string): string[] {
  const graph =
    `[0:v]${sourceChain(clip, fps, layers)},split=3[n][a][b];` +
    `[a]palettegen=stats_mode=diff[p];` +
    `[b][p]paletteuse=${PALETTEUSE[dither]}:diff_mode=rectangle[g]`;
  return [...BASE, '-y', ...seekArgs(clip), '-filter_complex', graph,
    '-map', '[n]', '-f', 'null', '-', '-map', '[g]', '-loop', '0', out];
}

/** One frame through the real scale + text pipeline, for checking text placement. */
export function previewFrameArgs(input: string, time: number, height: number, layers: TextLayers, out: string): string[] {
  const vf = [scaleFilter(height), ...textFilters(time, layers)].join(',');
  return [...BASE, '-y', '-ss', ffTime(time), '-i', input, '-frames:v', '1', '-vf', vf, out];
}

/** A still frame for videos the browser can't play. */
export function stillFrameArgs(input: string, time: number, height: number, out: string): string[] {
  return [...BASE, '-y', '-ss', ffTime(time), '-i', input, '-frames:v', '1',
    '-vf', scaleFilter(height), '-q:v', '4', out];
}

export function subtitleFile(streamIndex: number): string {
  return `${WORK}/track-${streamIndex}.ass`;
}

/** Convert text subtitle tracks to ASS in one pass (it reads the whole file, demux only). */
export function extractSubtitlesArgs(input: string, tracks: { index: number; codec: string }[]): string[] {
  const outputs = tracks.flatMap((t) => {
    const copy = t.codec === 'ass' || t.codec === 'ssa';
    return ['-map', `0:${t.index}`, '-c:s', copy ? 'copy' : 'ass', subtitleFile(t.index)];
  });
  return [...BASE, '-y', '-i', input, ...outputs];
}

/** Dump font attachments. ffmpeg exits non-zero (no output file), but the dump happens first. */
export function dumpFontArgs(input: string, fonts: { index: number; filename: string }[]): string[] {
  const dumps = fonts.flatMap((f) => {
    const ext = /\.(ttf|otf|ttc)$/i.exec(f.filename)?.[0].toLowerCase() ?? '.ttf';
    return [`-dump_attachment:${f.index}`, `${FONTS_DIR}/attachment-${f.index}${ext}`];
  });
  return [...BASE, '-y', ...dumps, '-i', input];
}
