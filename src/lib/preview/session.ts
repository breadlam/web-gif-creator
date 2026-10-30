// The preview for one open file: shows frames on a canvas and plays sound, choosing per
// track between the browser's decoders, our software decoders (lib/decode), and, for
// files Mediabunny can't read at all, ffmpeg-rendered stills and ffmpeg-decoded sound.

import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';
import { chooseDecodePath } from '../decode/soft';
import { stillFrame } from '../pipeline';
import type { MediaInfo } from '../probe';
import { AudioWindows, ffmpegRenderer, mediabunnyRenderer } from './audioWindows';
import { VideoView, type Frame } from './videoView';

export type { Frame };
export type VideoSource = 'browser' | 'software' | 'stills';
export type SoundSource = 'browser' | 'software' | 'ffmpeg' | 'none';

const STILL_INTERVAL = 1.5; // seconds between ffmpeg stills while playing in stills mode

export class PreviewSession {
  videoSource: VideoSource = 'stills';
  soundSource: SoundSource = 'none';
  playing = false;
  private input: Input | null = null;
  private offset = 0;
  private video: VideoView | null = null;
  private audio: AudioWindows | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private rate = 1;
  private clockBase = { at: 0, t: 0 };
  private token = 0;
  private stillToken = 0;
  private lastStill = -Infinity;
  current: Frame | null = null;

  private constructor(
    private file: File,
    /** The file's path in the main ffmpeg instance, for stills. */
    private inputPath: string,
    private info: MediaInfo,
    private audioEl: HTMLAudioElement,
    private onFrame: (f: Frame) => void,
  ) {}

  static async open(
    file: File, inputPath: string, info: MediaInfo, audioEl: HTMLAudioElement, onFrame: (f: Frame) => void,
  ): Promise<PreviewSession> {
    const s = new PreviewSession(file, inputPath, info, audioEl, onFrame);
    try {
      const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
      await input.getFormat();
      s.offset = Math.max(0, await input.getFirstTimestamp());
      s.input = input;
    } catch {
      s.input = null; // a container Mediabunny doesn't read: ffmpeg fallback
    }
    return s;
  }

  /** Select tracks by ffmpeg stream index. Mediabunny lists tracks in the same order. */
  async selectTracks(videoIndex: number, audioIndex: number | null): Promise<void> {
    this.stop();
    this.video?.dispose();
    this.audio?.dispose();
    this.video = null;
    this.audio = null;
    this.videoSource = 'stills';
    this.soundSource = 'none';

    const vOrder = this.info.videos.findIndex((v) => v.index === videoIndex);
    const vTrack = this.input && vOrder >= 0 ? (await this.input.getVideoTracks())[vOrder] : undefined;
    if (vTrack) {
      const path = await chooseDecodePath(await vTrack.getCodec(), await vTrack.getDecoderConfig());
      if (path !== 'none') {
        this.video = new VideoView(vTrack, this.offset, this.info.fps || 25, (f) => this.frame(f));
        this.videoSource = path;
        if (this.canvas) this.video.attach(this.canvas);
      }
    }

    if (audioIndex !== null) {
      const aOrder = this.info.audio.findIndex((a) => a.index === audioIndex);
      const aTrack = this.input && aOrder >= 0 ? (await this.input.getAudioTracks())[aOrder] : undefined;
      const path = aTrack ? await chooseDecodePath(await aTrack.getCodec(), await aTrack.getDecoderConfig()) : 'none';
      if (aTrack && path !== 'none') {
        this.audio = new AudioWindows(this.audioEl, mediabunnyRenderer(aTrack, this.offset), this.info.duration);
        this.soundSource = path;
      } else {
        this.audio = new AudioWindows(this.audioEl, ffmpegRenderer(this.file, audioIndex), this.info.duration);
        this.soundSource = 'ffmpeg';
      }
    }
  }

  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.video?.attach(canvas);
  }

  resize(width: number, height: number): void {
    this.video?.resize(width, height);
    if (!this.video && this.current) void this.still(this.current.ts);
  }

  private frame(f: Frame): void {
    this.current = f;
    this.onFrame(f);
  }

  /** Show the frame at t; fast = keyframe only, for scrubbing. */
  show(t: number, fast = false): void {
    if (this.video) this.video.show(t, fast);
    else void this.still(t);
  }

  step(n: number): void {
    if (this.video) {
      this.video.step(n);
      return;
    }
    const fps = this.info.fps || 25;
    const index = Math.floor((this.current?.ts ?? 0) * fps + 1e-3) + n;
    void this.still(Math.max(0, index / fps));
  }

  /** ffmpeg-rendered still for files Mediabunny can't decode. Only the latest request draws. */
  private async still(t: number): Promise<void> {
    const token = ++this.stillToken;
    const fps = this.info.fps || 25;
    const ts = Math.floor(t * fps + 1e-3) / fps;
    this.frame({ ts, dur: 1 / fps });
    const blob = await stillFrame(this.inputPath, this.info.videoIndex, ts).catch(() => null);
    if (!blob || token !== this.stillToken || !this.canvas) return;
    const bitmap = await createImageBitmap(blob);
    this.canvas.getContext('2d')?.drawImage(bitmap, 0, 0, this.canvas.width, this.canvas.height);
    bitmap.close();
  }

  /**
   * The playback clock in app time: the sound when it's playing, else wall time (no
   * sound, or the browser blocked it), so the video never waits on silence.
   */
  clock(): number {
    if (this.audio && this.playing && !this.audioEl.paused) {
      const t = this.audio.time();
      if (!Number.isNaN(t)) return t;
    }
    return this.clockBase.t + ((performance.now() - this.clockBase.at) / 1000) * this.rate;
  }

  /**
   * Play from t. onTick receives the clock each animation frame; the caller decides when
   * the clip has ended. Resolves once playback has started (after sound is decoded).
   */
  async play(t: number, onTick: (t: number) => void): Promise<void> {
    this.stop();
    const token = ++this.token;
    this.playing = true;
    if (this.audio) {
      await this.audio.prepare(t);
      if (token !== this.token) return;
      await this.audio.play(t).catch(() => undefined); // blocked: the clock falls back to wall time
    }
    this.clockBase = { at: performance.now(), t };
    this.video?.play(t, () => this.clock());
    const tick = () => {
      if (token !== this.token) return;
      const now = this.clock();
      if (this.audio && !this.audioEl.paused && !this.audio.covers(now) && !this.audio.finished()) {
        // Ran out of decoded sound: pause briefly while the next stretch decodes.
        void this.refill(now, token, onTick);
        return;
      }
      if (!this.video && now - this.lastStill >= STILL_INTERVAL) {
        this.lastStill = now;
        void this.still(now);
      }
      onTick(this.audio?.finished() ? this.info.duration : now);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  private async refill(t: number, token: number, onTick: (t: number) => void): Promise<void> {
    this.video?.stop();
    this.audio!.pause();
    await this.audio!.prepare(t).catch(() => undefined);
    if (token === this.token) void this.play(t, onTick);
  }

  /** Stop playback, leaving the last frame on screen. */
  stop(): void {
    this.token++;
    this.playing = false;
    this.video?.stop();
    this.audio?.pause();
  }

  setRate(rate: number): void {
    if (this.playing) this.clockBase = { at: performance.now(), t: this.clock() };
    this.rate = rate;
    this.audioEl.playbackRate = rate;
  }

  dispose(): void {
    this.stop();
    this.video?.dispose();
    this.audio?.dispose();
    this.input?.dispose();
  }
}
