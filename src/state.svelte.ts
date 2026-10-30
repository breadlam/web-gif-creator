import type { Cue, TextOverlay } from './lib/ass';
import { parseAssCues } from './lib/ass';
import { Cancelled, engine } from './lib/engine';
import { fontInfo } from './lib/fontNames';
import { extractMkvSubtitles } from './lib/mkvSubtitles';
import { allFonts, registerFont, unregisterFonts, type FontChoice, type FontId } from './lib/fonts';
import {
  addFontFile, encodeGif, extractSubtitles, loadFonts, openFile, planClip, previewFrame,
  writeTextLayers, type Job, type Plan,
} from './lib/pipeline';
import { defaultAudioTrack, outputWidth, videoFields, type MediaInfo } from './lib/probe';
import { frameCount, snapFps, type DitherMode } from './lib/sizeModel';
import { bestTrack, DEFAULT_SUBTITLE_STYLE, type SubtitleMode, type SubtitleStyle } from './lib/subtitles';
import { compactTime } from './lib/time';

export interface Settings {
  maxMB: number;
  height: number;
  dither: DitherMode;
  /** Bayer pattern strength 0–5, used when dither is 'bayer'. */
  bayerScale: number;
  fpsMode: 'auto' | 'manual';
  manualFps: number;
  subtitleStyle: SubtitleStyle;
}

const DEFAULTS: Settings = {
  maxMB: 20, height: 540, dither: 'sierra2_4a', bayerScale: 2, fpsMode: 'auto', manualFps: 15,
  subtitleStyle: { ...DEFAULT_SUBTITLE_STYLE },
};
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
  current: 0,
  /** Audio stream to hear while trimming. */
  audioTrack: null as number | null,
  start: 0,
  end: 0,
  settings: loadSettings(),
  /** Every text subtitle track, converted to ASS, by stream index. */
  subtitleTracks: {} as Record<number, string>,
  subtitleStatus: 'none' as 'none' | 'loading' | 'ready' | 'failed',
  track: null as number | null,
  cues: [] as Cue[],
  subMode: 'off' as SubtitleMode,
  disabledCues: [] as number[],
  cueOverrides: {} as Record<number, string>,
  embeddedFonts: 0,
  /** Every name libass can match a loaded font by (bundled, embedded, added). */
  fontNames: [] as string[],
  /** Fonts to offer for captions and subtitle styling (mirrors lib/fonts' registry). */
  fontChoices: [...allFonts()] as FontChoice[],
  overlays: [] as TextOverlay[],
  /**
   * The text being edited: a caption's id, or 'subtitles' for the subtitle style. Only
   * this text is drawn (dimmed) when it isn't on screen at the current frame, so it can
   * still be seen and moved; otherwise the preview shows just what the GIF will.
   */
  editing: null as string | null,
  plan: null as Plan | null,
  planKey: '',
  busy: null as null | { label: string; fraction: number | null },
  error: '',
  output: null as Output | null,
  preview: null as null | { url: string; time: number },
  log: [] as string[],
});

export const playback = $state({ playing: false, loop: true, volume: 1, muted: false, rate: 1 });

/** Registered by Player so other components can drive the video. */
export const controls = {
  /** Jump to a time, showing the exact frame. */
  seek: (_t: number) => {},
  /** Follow a drag: show the nearest keyframe (fast), playhead at t. */
  scrub: (_t: number) => {},
  toggle: () => {},
  /** Step by whole source frames; repeated calls (a held arrow key) scrub. */
  step: (_frames: number) => {},
};

export function frameDuration(): number {
  return 1 / (app.info?.fps || 25);
}

/**
 * Start time of the frame at time t, on the 1/fps grid. Rounds to the nearest boundary:
 * frame times come from the container, which may store them slightly early (Matroska
 * stores frame 1 at 30 fps as 0.033, not 0.0333).
 */
function frameStart(t: number): number {
  const fps = app.info?.fps || 25;
  return Math.round(t * fps) / fps;
}

/**
 * Set the clip start. If it lands at or past the end, the end is cleared back to the end
 * of the video, so playing on from here runs until a new end is chosen.
 */
export function setStart(t: number): void {
  const f = frameDuration();
  const duration = app.info?.duration ?? 0;
  app.start = Math.max(0, Math.min(t, duration - f));
  if (app.end <= app.start) app.end = duration;
}

/** Set the clip end. If it lands at or before the start, the start is cleared to 0. */
export function setEnd(t: number): void {
  const f = frameDuration();
  const duration = app.info?.duration ?? 0;
  app.end = Math.min(duration, Math.max(t, f));
  if (app.start >= app.end) app.start = 0;
}

/** Start the clip at the frame on screen. */
export function setStartHere(t = app.current): void {
  setStart(frameStart(t));
}

/** End the clip after the frame on screen, so that frame is included. */
export function setEndHere(t = app.current): void {
  setEnd(frameStart(t) + frameDuration());
}

/**
 * Drag the clip start to the frame at t, stopping one frame short of the end. Returns
 * the start, where the playhead should be so it shows the clip's first frame.
 */
export function dragStartTo(t: number): number {
  app.start = Math.min(Math.max(0, frameStart(t)), app.end - frameDuration());
  return app.start;
}

/**
 * Drag the clip end so the frame at t is the last one included, stopping one frame past
 * the start. Returns that last frame's time, where the playhead should be.
 */
export function dragEndTo(t: number): number {
  const f = frameDuration();
  app.end = Math.max(Math.min(app.info?.duration ?? 0, frameStart(t) + f), app.start + f);
  return app.end - f;
}

engine.onLog((line) => {
  app.log.push(line);
  if (app.log.length > 400) app.log.splice(0, app.log.length - 400);
});

export function selectVideoTrack(index: number): void {
  const track = app.info?.videos.find((v) => v.index === index);
  if (!app.info || !track) return;
  Object.assign(app.info, videoFields(track));
  app.plan = null;
}

/** Everything the frame-rate calculation depends on; a plan is stale when this changes. */
export function planKey(): string {
  const s = app.settings;
  return JSON.stringify([
    app.input, app.info?.videoIndex, app.start, app.end, s.maxMB, s.height, s.dither, s.bayerScale, s.fpsMode, s.manualFps,
    app.track, app.subMode, app.subMode === 'custom' ? s.subtitleStyle : null, app.disabledCues,
    app.cueOverrides, app.overlays,
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
  Object.assign(app, {
    file, info: null, input: '',
    audioTrack: null,
    subtitleTracks: {}, subtitleStatus: 'none', track: null, cues: [], subMode: 'off', disabledCues: [],
    cueOverrides: {}, plan: null, planKey: '', output: null,
    preview: null, overlays: [], editing: null,
  });
  await run('Reading video', async (progress) => {
    const { info, input } = await openFile(file);
    app.info = info;
    app.input = input;
    app.audioTrack = defaultAudioTrack(info.audio);
    app.current = 0;
    // No clip chosen yet: the whole video, until a start and end are set.
    app.start = 0;
    app.end = info.duration;
    if (info.unsupported) return;
    progress(null, 'Loading fonts');
    unregisterFonts('embedded');
    const fonts = await loadFonts(input, info);
    app.embeddedFonts = fonts.embedded;
    app.fontNames = [...fonts.names, ...addedFontNames];
    for (const bytes of fonts.files) registerFontBytes(bytes, 'embedded');
    app.fontChoices = [...allFonts()];
  });
  if (app.info?.subtitles.some((t) => t.text) && !app.info.unsupported) await loadSubtitles();
}

/** Read every text subtitle track (one pass over the file) and pick the most useful one. */
export async function loadSubtitles(): Promise<void> {
  if (!app.info) return;
  const info = $state.snapshot(app.info) as MediaInfo;
  app.subtitleStatus = 'loading';
  const file = app.file!;
  const tracks = await run('Reading subtitles', async (progress) => {
    // Matroska/WebM: read in JavaScript (fast); anything else, or a parse failure: ffmpeg.
    if (/matroska|webm/.test(info.container)) {
      const scripts = await extractMkvSubtitles(file, (f) => progress(f, 'Reading subtitles')).catch(() => null);
      if (scripts && scripts.length === info.subtitles.length) {
        return Object.fromEntries(
          info.subtitles.flatMap((t, i) => (t.text && scripts[i] ? [[t.index, scripts[i]] as const] : [])),
        );
      }
    }
    return extractSubtitles(app.input, info, progress);
  });
  if (!tracks || app.info?.duration !== info.duration) {
    app.subtitleStatus = 'failed';
    return;
  }
  app.subtitleTracks = tracks;
  app.subtitleStatus = 'ready';
  const counts = Object.fromEntries(Object.entries(tracks).map(([i, ass]) => [i, parseAssCues(ass).length]));
  selectTrack(bestTrack(info.subtitles, counts, navigator.language || 'en'));
}

export function selectTrack(index: number | null): void {
  app.track = index;
  app.cues = index === null || !(index in app.subtitleTracks) ? [] : parseAssCues(app.subtitleTracks[index]);
  app.disabledCues = [];
  app.cueOverrides = {};
}

/** Set the clip range to a subtitle line. */
export function clipToCue(cue: Cue): void {
  app.start = Math.max(0, cue.start);
  app.end = Math.min(app.info?.duration ?? cue.end, cue.end);
  controls.seek(app.start);
}

/** Grow the clip range to include a subtitle line. */
export function extendToCue(cue: Cue): void {
  app.start = Math.max(0, Math.min(app.start, cue.start));
  app.end = Math.max(app.end, Math.min(app.info?.duration ?? cue.end, cue.end));
}

export function setCueText(cue: Cue, text: string): void {
  if (text === cue.text) delete app.cueOverrides[cue.line];
  else app.cueOverrides[cue.line] = text;
}

async function job(range: [number, number] = [app.start, app.end]): Promise<Job> {
  const { width, height } = outputSize();
  const layers = await writeTextLayers(
    {
      subtitles: {
        mode: app.subMode,
        ass: app.track === null ? null : (app.subtitleTracks[app.track] ?? null),
        cues: $state.snapshot(app.cues) as Cue[],
        disabled: new Set(app.disabledCues),
        overrides: $state.snapshot(app.cueOverrides) as Record<number, string>,
        style: $state.snapshot(app.settings.subtitleStyle) as SubtitleStyle,
      },
      overlays: $state.snapshot(app.overlays) as TextOverlay[],
      fonts: $state.snapshot(app.fontNames) as string[],
    },
    width,
    height,
    range,
  );
  return {
    input: app.input,
    info: $state.snapshot(app.info) as MediaInfo,
    start: app.start,
    end: app.end,
    height,
    dither: { mode: app.settings.dither, bayerScale: app.settings.bayerScale },
    layers,
  };
}

export async function calculate(): Promise<Plan | undefined> {
  const key = planKey();
  const s = app.settings;
  const plan = await run('Analysing motion', async (progress) =>
    planClip(await job(), {
      budget: s.maxMB * 1e6,
      uniform: false,
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
  return snapFps(o.fps * (o.budget / o.bytes) * 0.97, false).fps;
}

export async function renderPreview(): Promise<void> {
  const time = app.current;
  const blob = await run('Rendering preview frame', async () => previewFrame(await job([time, time + 0.001]), time));
  if (!blob) return;
  if (app.preview) URL.revokeObjectURL(app.preview.url);
  app.preview = { url: URL.createObjectURL(blob), time };
}

let fontCounter = 0;
const addedFontNames: string[] = [];

/**
 * Offer a font for captions: register it with the browser (for the preview) and in the
 * font list. Returns its id, or null if the file isn't a readable font. A font with the
 * same family and weight as one already listed isn't listed twice.
 */
function registerFontBytes(bytes: Uint8Array, source: 'embedded' | 'added'): FontId | null {
  const info = fontInfo(bytes);
  if (!info) return null;
  const existing = allFonts().find((f) => f.family === info.family && f.bold === info.bold);
  if (existing) return existing.id;
  const n = ++fontCounter;
  const css = `wgc-font-${n}`;
  try {
    const face = new FontFace(css, bytes.slice().buffer, { weight: info.bold ? '700' : '400' });
    document.fonts.add(face);
    face.load().catch(() => undefined);
  } catch {
    // The preview falls back to a default font; libass still uses the real one.
  }
  const choice: FontChoice = {
    id: `${source}-${n}`,
    label: `${info.fullName}${source === 'embedded' ? ' (in video)' : ''}`,
    family: info.family,
    bold: info.bold,
    css,
    cssPerAss: info.cssPerAss,
    source,
  };
  registerFont(choice);
  return choice.id;
}

/** Add a font file chosen by the user. Returns the new font's id. */
export async function addUserFont(file: File): Promise<FontId | null> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!fontInfo(bytes)) {
    app.error = `${file.name} isn't a font file this app can read (use TTF, OTF or TTC).`;
    return null;
  }
  const ext = /\.(ttf|otf|ttc)$/i.exec(file.name)?.[0].toLowerCase() ?? '.ttf';
  const names = await addFontFile(bytes, `added-${fontCounter + 1}${ext}`);
  addedFontNames.push(...names);
  app.fontNames = [...app.fontNames, ...names];
  const id = registerFontBytes(bytes, 'added');
  app.fontChoices = [...allFonts()];
  return id;
}

let overlayCounter = 0;

export function addOverlay(): string {
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
  return o.id;
}

export function removeOverlay(id: string): void {
  app.overlays = app.overlays.filter((o) => o.id !== id);
  if (app.editing === id) app.editing = null;
}

/**
 * Focus handlers for everything that edits one piece of text (its controls, and the text
 * itself on the video), each marked data-edit={key}. The text counts as being edited
 * while focus is inside any of them.
 */
export function editHandlers(key: string) {
  return {
    onfocusin: () => (app.editing = key),
    // Check once focus has landed. Switching windows (or opening a native colour picker)
    // takes focus from the document without moving it, and doesn't end editing.
    onfocusout: () =>
      setTimeout(() => {
        if (app.editing !== key || !document.hasFocus()) return;
        if (!document.activeElement?.closest(`[data-edit="${key}"]`)) app.editing = null;
      }),
  };
}
