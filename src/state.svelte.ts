import type { Cue, TextOverlay } from './lib/ass';
import { parseAssCues } from './lib/ass';
import { Cancelled, engine } from './lib/engine';
import {
  encodeGif, extractSubtitles, loadFonts, openFile, planClip, previewFrame, stillFrame,
  writeTextLayers, type Job, type Plan,
} from './lib/pipeline';
import { outputWidth, type MediaInfo } from './lib/probe';
import { frameCount, snapFps, type Dither } from './lib/sizeModel';
import { compactTime } from './lib/time';

export interface Settings {
  maxMB: number;
  height: number;
  dither: Dither;
  fpsMode: 'auto' | 'manual';
  manualFps: number;
  uniform: boolean;
}

const DEFAULTS: Settings = { maxMB: 20, height: 540, dither: 'sierra2_4a', fpsMode: 'auto', manualFps: 15, uniform: true };
const SETTINGS_KEY = 'web-gif-creator.settings';

function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // Storage unavailable (private mode etc.): settings just won't persist.
  }
}

export interface Output {
  url: string;
  bytes: number;
  fps: number;
  frames: number;
  budget: number;
  expectedBytes: number | null;
  name: string;
}

export const app = $state({
  engine: 'loading' as 'loading' | 'ready' | 'failed',
  file: null as File | null,
  input: '',
  info: null as MediaInfo | null,
  videoUrl: '',
  playable: true,
  stillUrl: '',
  current: 0,
  start: 0,
  end: 0,
  settings: loadSettings(),
  track: null as number | null,
  subtitleAss: null as string | null,
  cues: [] as Cue[],
  disabledCues: [] as number[],
  embeddedFonts: 0,
  fontNames: [] as string[],
  overlays: [] as TextOverlay[],
  selected: null as string | null,
  plan: null as Plan | null,
  planKey: '',
  busy: null as null | { label: string; fraction: number | null },
  error: '',
  output: null as Output | null,
  preview: null as null | { url: string; time: number },
  log: [] as string[],
});

export const playback = $state({ playing: false, loop: true });

/** Registered by Player so other components can drive the video. */
export const controls = {
  seek: (_t: number) => {},
  toggle: () => {},
};

engine.onLog((line) => {
  app.log.push(line);
  if (app.log.length > 400) app.log.splice(0, app.log.length - 400);
});

/** Everything the frame-rate calculation depends on; a plan is stale when this changes. */
export function planKey(): string {
  const s = app.settings;
  return JSON.stringify([
    app.input, app.start, app.end, s.maxMB, s.height, s.dither, s.uniform, s.fpsMode, s.manualFps,
    app.track, app.disabledCues, app.overlays,
  ]);
}

export function outputSize(): { width: number; height: number } {
  return { width: app.info ? outputWidth(app.info, app.settings.height) : 0, height: app.settings.height };
}

async function run<T>(label: string, fn: (progress: (f: number | null, l?: string) => void) => Promise<T>): Promise<T | undefined> {
  app.error = '';
  app.busy = { label, fraction: null };
  try {
    return await fn((fraction, l) => {
      app.busy = { label: l ?? label, fraction };
    });
  } catch (e) {
    if (!(e instanceof Cancelled)) {
      console.error(e);
      app.error = e instanceof Error ? e.message : String(e);
    }
    return undefined;
  } finally {
    app.busy = null;
  }
}

export function cancel(): void {
  engine.cancel();
}

export async function openVideo(file: File): Promise<void> {
  if (app.busy) cancel();
  if (app.videoUrl) URL.revokeObjectURL(app.videoUrl);
  Object.assign(app, {
    file, info: null, input: '', videoUrl: URL.createObjectURL(file), playable: true, stillUrl: '',
    track: null, subtitleAss: null, cues: [], disabledCues: [], plan: null, planKey: '', output: null,
    preview: null, overlays: [], selected: null,
  });
  await run('Reading video', async (progress) => {
    const { info, input } = await openFile(file);
    app.info = info;
    app.input = input;
    app.current = 0;
    app.start = 0;
    app.end = Math.min(info.duration, 5);
    if (info.unsupported) return;
    progress(null, 'Loading fonts');
    const fonts = await loadFonts(input, info);
    app.embeddedFonts = fonts.embedded;
    app.fontNames = fonts.names;
  });
}

export async function selectTrack(index: number | null): Promise<void> {
  app.track = index;
  app.subtitleAss = null;
  app.cues = [];
  app.disabledCues = [];
  const track = app.info?.subtitles.find((t) => t.index === index);
  if (!track || !app.info) return;
  const info = $state.snapshot(app.info) as MediaInfo;
  const ass = await run('Extracting subtitles', (progress) => extractSubtitles(app.input, info, track, progress));
  if (ass === undefined || app.track !== index) return;
  app.subtitleAss = ass;
  app.cues = parseAssCues(ass);
}

async function job(): Promise<Job> {
  const { width, height } = outputSize();
  const layers = await writeTextLayers(
    {
      subtitleAss: app.subtitleAss,
      disabledCues: new Set(app.disabledCues),
      overlays: $state.snapshot(app.overlays) as TextOverlay[],
      fonts: $state.snapshot(app.fontNames) as string[],
    },
    width,
    height,
  );
  return {
    input: app.input,
    info: $state.snapshot(app.info) as MediaInfo,
    start: app.start,
    end: app.end,
    height,
    dither: app.settings.dither,
    layers,
  };
}

export async function calculate(): Promise<Plan | undefined> {
  const key = planKey();
  const s = app.settings;
  const plan = await run('Analysing motion', async (progress) =>
    planClip(await job(), {
      budget: s.maxMB * 1e6,
      uniform: s.uniform,
      manualFps: s.fpsMode === 'manual' ? s.manualFps : null,
    }, progress),
  );
  if (plan) {
    app.plan = plan;
    app.planKey = key;
  }
  return plan;
}

export async function encode(fpsOverride?: number): Promise<void> {
  let plan = app.plan && app.planKey === planKey() ? app.plan : undefined;
  if (!plan && fpsOverride === undefined) plan = await calculate();
  const fps = fpsOverride ?? plan?.fps;
  if (fps === undefined || !app.file) return;
  const name = `${app.file.name.replace(/\.[^.]+$/, '')}_${compactTime(app.start)}-${compactTime(app.end)}.gif`;
  const gif = await run('Encoding GIF', async (progress) => encodeGif(await job(), fps, progress));
  if (!gif) return;
  if (app.output) URL.revokeObjectURL(app.output.url);
  app.output = {
    url: URL.createObjectURL(new Blob([gif as BlobPart], { type: 'image/gif' })),
    bytes: gif.length,
    fps,
    frames: frameCount(app.end - app.start, fps),
    budget: app.settings.maxMB * 1e6,
    expectedBytes: fpsOverride === undefined && plan ? plan.expectedBytes : null,
    name,
  };
}

/** Frame rate to retry at when a GIF came out over budget. */
export function retryFps(o: Output): number {
  return snapFps(o.fps * (o.budget / o.bytes) * 0.97, app.settings.uniform).fps;
}

export async function renderPreview(): Promise<void> {
  const time = app.current;
  const blob = await run('Rendering preview frame', async () => previewFrame(await job(), time));
  if (!blob) return;
  if (app.preview) URL.revokeObjectURL(app.preview.url);
  app.preview = { url: URL.createObjectURL(blob), time };
}

let stillBusy = false;
let stillWanted: number | null = null;

/** Show ffmpeg-rendered stills when the browser can't play the file. */
export async function requestStill(time: number): Promise<void> {
  stillWanted = time;
  if (stillBusy || app.busy) return;
  stillBusy = true;
  try {
    while (stillWanted !== null) {
      const t = stillWanted;
      stillWanted = null;
      const blob = await stillFrame(app.input, t).catch(() => null);
      if (!blob) continue;
      if (app.stillUrl) URL.revokeObjectURL(app.stillUrl);
      app.stillUrl = URL.createObjectURL(blob);
    }
  } finally {
    stillBusy = false;
  }
}

let overlayCounter = 0;

export function addOverlay(): void {
  const o: TextOverlay = {
    id: `t${++overlayCounter}`,
    text: 'Your text',
    font: 'noto-bold',
    size: 9,
    color: '#ffffff',
    outlineColor: '#000000',
    outline: 0.6,
    x: 0.5,
    y: 0.86,
    start: app.start,
    end: app.end,
  };
  app.overlays.push(o);
  app.selected = o.id;
}

export function removeOverlay(id: string): void {
  app.overlays = app.overlays.filter((o) => o.id !== id);
  if (app.selected === id) app.selected = null;
}

/** Turn a subtitle cue into an editable text overlay and stop burning the original. */
export function cueToOverlay(cue: Cue): void {
  addOverlay();
  const o = app.overlays[app.overlays.length - 1];
  o.text = cue.text;
  o.start = cue.start;
  o.end = cue.end;
  if (!app.disabledCues.includes(cue.line)) app.disabledCues.push(cue.line);
}
