import { audioPreviewArgs } from './commands';
import { Engine } from './engine';

/** MIME types to ask the browser about, by ffmpeg codec name. */
const AUDIO_MIME: Record<string, string> = {
  aac: 'audio/mp4; codecs="mp4a.40.2"',
  mp3: 'audio/mpeg',
  opus: 'audio/webm; codecs="opus"',
  vorbis: 'audio/webm; codecs="vorbis"',
  flac: 'audio/flac',
  alac: 'audio/mp4; codecs="alac"',
  ac3: 'audio/mp4; codecs="ac-3"',
  eac3: 'audio/mp4; codecs="ec-3"',
  pcm_s16le: 'audio/wav; codecs="1"',
};

/** Whether the browser can decode this audio codec itself. DTS, TrueHD etc. never. */
export function browserDecodes(codec: string): boolean {
  const mime = AUDIO_MIME[codec];
  return !!mime && document.createElement('audio').canPlayType(mime) !== '';
}

const WINDOW = 60; // seconds decoded per request
const LEAD = 2; // seconds before the requested time, so small seeks back stay in the window
const DRIFT = 0.15; // resync when audio and video differ by more than this

interface Loaded {
  track: number;
  from: number;
  to: number;
  url: string;
}

/**
 * Plays a file's audio through ffmpeg when the browser can't: decodes a minute around
 * the playhead to MP3 in its own ffmpeg.wasm instance (so it never waits behind GIF
 * work) and plays it in an <audio> element kept in sync with the video.
 */
export class AudioPreview {
  private engine: Engine | null = null;
  private input: Promise<string> | null = null;
  private file: File | null = null;
  private loaded: Loaded | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private el: HTMLAudioElement | null = null;

  attach(el: HTMLAudioElement): void {
    this.el = el;
  }

  setFile(file: File | null): void {
    if (file === this.file) return;
    this.file = file;
    this.input = null;
    this.unload();
  }

  private unload(): void {
    if (this.loaded) URL.revokeObjectURL(this.loaded.url);
    this.loaded = null;
    this.el?.pause();
    this.el?.removeAttribute('src');
  }

  covers(track: number, t: number): boolean {
    const l = this.loaded;
    return !!l && l.track === track && t >= l.from && (t < l.to - 0.5 || l.to - l.from < WINDOW);
  }

  /** Make sure audio around time t is loaded. Resolves once it can play. */
  prepare(track: number, t: number, duration: number): Promise<void> {
    const run = this.chain.then(async () => {
      if (this.covers(track, t) || !this.file || !this.el) return;
      this.engine ??= new Engine();
      this.input ??= this.engine.setInput(this.file);
      const input = await this.input;
      const from = Math.max(0, t - LEAD);
      const to = Math.min(duration, from + WINDOW);
      const out = '/work/audio-preview.mp3';
      const r = await this.engine.exec(audioPreviewArgs(input, track, from, to - from, out));
      if (r.code !== 0 || !(await this.engine.exists(out))) throw new Error('ffmpeg could not decode this audio track');
      const bytes = await this.engine.read(out);
      await this.engine.remove(out);
      this.unload();
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'audio/mpeg' }));
      this.loaded = { track, from, to, url };
      const el = this.el;
      await new Promise<void>((resolve, reject) => {
        el.onloadedmetadata = () => resolve();
        el.onerror = () => reject(new Error('The browser could not play the decoded audio'));
        el.src = url;
      });
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Source-video time the audio is at, or NaN when nothing is loaded. */
  time(): number {
    return this.loaded && this.el ? this.loaded.from + this.el.currentTime : NaN;
  }

  async play(t: number): Promise<void> {
    if (!this.loaded || !this.el) return;
    this.el.currentTime = Math.max(0, t - this.loaded.from);
    await this.el.play();
  }

  pause(): void {
    this.el?.pause();
  }

  /** Nudge the audio back to the video time t. False when t is outside the loaded window. */
  sync(track: number, t: number): boolean {
    if (!this.covers(track, t) || !this.el || !this.loaded) return false;
    if (Math.abs(this.time() - t) > DRIFT) this.el.currentTime = t - this.loaded.from;
    return true;
  }
}
