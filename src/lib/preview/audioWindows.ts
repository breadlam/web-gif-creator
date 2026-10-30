// Preview sound: decoded stretches ("windows") of one audio track played in an <audio>
// element, which keeps pitch at any playback speed. The element's time drives playback,
// and a new window is decoded when the playhead leaves the current one.

import { AudioBufferSink, type InputAudioTrack } from 'mediabunny';
import { audioPreviewArgs } from '../commands';
import { Engine } from '../engine';

/** Decodes the sound between two app times into something an <audio> element plays. */
export type WindowRenderer = (from: number, to: number) => Promise<Blob>;

const FIRST_WINDOW = 30; // short, so the first Play starts quickly
const WINDOW = 120;
const LEAD = 2; // seconds before the requested time, so small seeks back stay in the window
const DRIFT = 0.15; // resync when audio and video differ by more than this

interface Loaded {
  from: number;
  to: number;
  url: string;
  /** The window runs to the end of the file. */
  last: boolean;
}

export class AudioWindows {
  private loaded: Loaded | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private windows = 0;

  constructor(
    private el: HTMLAudioElement,
    private render: WindowRenderer,
    private duration: number,
  ) {}

  private unload(): void {
    if (this.loaded) URL.revokeObjectURL(this.loaded.url);
    this.loaded = null;
    this.el.pause();
    this.el.removeAttribute('src');
  }

  covers(t: number): boolean {
    const l = this.loaded;
    return !!l && t >= l.from && (t < l.to - 0.5 || l.last);
  }

  /** Make sure sound around time t is loaded. Resolves once it can play. */
  prepare(t: number): Promise<void> {
    const run = this.chain.then(async () => {
      if (this.covers(t)) return;
      const from = Math.max(0, t - LEAD);
      const to = Math.min(this.duration, from + (this.windows++ === 0 ? FIRST_WINDOW : WINDOW));
      const blob = await this.render(from, to);
      this.unload();
      const url = URL.createObjectURL(blob);
      this.loaded = { from, to, url, last: to >= this.duration - 1e-3 };
      await new Promise<void>((resolve, reject) => {
        this.el.onloadedmetadata = () => resolve();
        this.el.onerror = () => reject(new Error('The browser could not play the decoded sound'));
        this.el.src = url;
      });
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** App time the sound is at, or NaN when nothing is loaded. */
  time(): number {
    return this.loaded ? this.loaded.from + this.el.currentTime : NaN;
  }

  /** The sound has played to the end of the file. */
  finished(): boolean {
    return !!this.loaded?.last && this.el.ended;
  }

  async play(t: number): Promise<void> {
    if (!this.loaded) return;
    this.el.currentTime = Math.max(0, t - this.loaded.from);
    await this.el.play();
  }

  pause(): void {
    this.el.pause();
  }

  /** Nudge the sound back to time t. False when t is outside the loaded window. */
  sync(t: number): boolean {
    if (!this.covers(t) || !this.loaded) return false;
    if (Math.abs(this.time() - t) > DRIFT) this.el.currentTime = t - this.loaded.from;
    return true;
  }

  dispose(): void {
    this.unload();
  }
}

/** Sound decoded by Mediabunny (browser or software decoders), as 16-bit WAV. */
export function mediabunnyRenderer(track: InputAudioTrack, offset: number): WindowRenderer {
  const sink = new AudioBufferSink(track);
  return async (from, to) => {
    const buffers: AudioBuffer[] = [];
    let first = NaN;
    for await (const { buffer, timestamp } of sink.buffers(from + offset, to + offset)) {
      if (Number.isNaN(first)) first = timestamp - offset;
      buffers.push(buffer);
    }
    // Pad the start if decoding began slightly after `from`, so window times line up.
    const lead = Number.isNaN(first) ? 0 : Math.max(0, first - from);
    return wavFromBuffers(buffers, lead);
  };
}

/** Sound decoded by ffmpeg.wasm in its own instance, as MP3 (for codecs Mediabunny lacks). */
export function ffmpegRenderer(file: File, streamIndex: number): WindowRenderer {
  const engine = new Engine();
  const input = engine.setInput(file);
  return async (from, to) => {
    const out = '/work/audio-preview.mp3';
    const r = await engine.exec(audioPreviewArgs(await input, streamIndex, from, to - from, out));
    if (r.code !== 0 || !(await engine.exists(out))) throw new Error('ffmpeg could not decode this audio track');
    const bytes = await engine.read(out);
    await engine.remove(out);
    return new Blob([bytes as BlobPart], { type: 'audio/mpeg' });
  };
}

/**
 * Interleave decoded buffers into a stereo (or mono) 16-bit WAV. Surround is folded down
 * with the centre channel kept, since that's where dialogue is. Channel order is the
 * usual WAV/FFmpeg one: FL FR FC LFE BL BR SL SR.
 */
export function wavFromBuffers(buffers: AudioBuffer[], leadSeconds = 0): Blob {
  const rate = buffers[0]?.sampleRate ?? 48000;
  const inChannels = buffers[0]?.numberOfChannels ?? 1;
  const outChannels = inChannels === 1 ? 1 : 2;
  const lead = Math.round(leadSeconds * rate);
  const frames = lead + buffers.reduce((n, b) => n + b.length, 0);
  const bytes = 44 + frames * outChannels * 2;
  const view = new DataView(new ArrayBuffer(bytes));
  const text = (o: number, s: string) => [...s].forEach((ch, i) => view.setUint8(o + i, ch.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, bytes - 8, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, outChannels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * outChannels * 2, true);
  view.setUint16(32, outChannels * 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, frames * outChannels * 2, true);
  let o = 44 + lead * outChannels * 2;
  const put = (v: number) => {
    view.setInt16(o, Math.max(-1, Math.min(1, v)) * 0x7fff, true);
    o += 2;
  };
  const C = Math.SQRT1_2;
  for (const b of buffers) {
    const ch = Array.from({ length: b.numberOfChannels }, (_, i) => b.getChannelData(i));
    for (let i = 0; i < b.length; i++) {
      if (outChannels === 1) put(ch[0][i]);
      else if (ch.length === 2) {
        put(ch[0][i]);
        put(ch[1][i]);
      } else {
        const fc = ch[2]?.[i] ?? 0;
        const left = ch[0][i] + C * fc + C * ((ch[4]?.[i] ?? 0) + (ch[6]?.[i] ?? 0));
        const right = ch[1][i] + C * fc + C * ((ch[5]?.[i] ?? 0) + (ch[7]?.[i] ?? 0));
        // Scale so a full-level centre plus fronts can't clip.
        put(left / (1 + C + C));
        put(right / (1 + C + C));
      }
    }
  }
  return new Blob([view.buffer], { type: 'audio/wav' });
}
