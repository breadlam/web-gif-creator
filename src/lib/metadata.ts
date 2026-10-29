import type { Feature } from './sizeModel';

/**
 * Parse metadata=mode=print output into one value per frame (null when the frame
 * carried no value for `key`, e.g. bbox found no changed pixels).
 */
export function parseFrameMetadata(text: string, key: string): (number | null)[] {
  const frames: (number | null)[] = [];
  let cur: number | null = null;
  let started = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('frame:')) {
      if (started) frames.push(cur);
      cur = null;
      started = true;
    } else if (line.startsWith(key + '=')) {
      cur = parseFloat(line.slice(key.length + 1));
    }
  }
  if (started) frames.push(cur);
  return frames;
}

/**
 * Per-clip feature value: the mean over the clip's `frames` GIF frames of the changed
 * fraction, counting the first frame (which tblend drops) as fully changed. metadata=print
 * skips frames with no value (e.g. no changed pixels), so those count as zero. Matches
 * calibrate.py.
 */
export function featureValue(f: Feature, text: string, width: number, height: number, frames: number): number {
  let fractions: number[];
  if (f.kind === 'bbox') {
    const ws = parseFrameMetadata(text, 'lavfi.bbox.w');
    const hs = parseFrameMetadata(text, 'lavfi.bbox.h');
    fractions = ws.map((w, i) => ((w ?? 0) * (hs[i] ?? 0)) / (width * height));
  } else {
    fractions = parseFrameMetadata(text, 'lavfi.signalstats.YAVG').map((v) => (v ?? 0) / 255);
  }
  return (1 + fractions.reduce((a, b) => a + b, 0)) / Math.max(frames, fractions.length + 1);
}

/** ffmpeg stats line "frame=  123 ..." -> 123 */
export function parseFrameProgress(line: string): number | null {
  const m = /frame=\s*(\d+)/.exec(line);
  return m ? parseInt(m[1], 10) : null;
}

/** ffmpeg stats line "... time=00:01:02.50 ..." -> 62.5 */
export function parseTimeProgress(line: string): number | null {
  const m = /time=\s*(-?)(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
  if (!m || m[1]) return null;
  return +m[2] * 3600 + +m[3] * 60 + parseFloat(m[4]);
}
