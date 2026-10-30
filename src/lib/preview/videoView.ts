// Shows one video track on a canvas, decoding with Mediabunny (WebCodecs, or the software
// decoders in lib/decode). Exact frames are decoded a group of pictures at a time and
// cached, so stepping back and forth is instant; scrubbing shows keyframes only, which
// decode in one packet; playback streams frames ahead of a clock.
//
// Times here are app times: media timestamps minus the file's first timestamp, which is
// how ffmpeg's -ss counts.

import { EncodedPacketSink, VideoSampleSink, type InputVideoTrack, type VideoSample } from 'mediabunny';

export interface Frame {
  ts: number;
  dur: number;
}

interface Cached extends Frame {
  bitmap: ImageBitmap;
}

const AHEAD = 1.5; // seconds of frames to decode past an exact seek, for forward steps
const BEHIND = 6; // seconds of frames before it to keep cached, for backward steps
const CACHE_BYTES = 160 * 1024 * 1024;
const PLAY_QUEUE = 8;

export class VideoView {
  private sink: VideoSampleSink;
  private packets: EncodedPacketSink;
  private cache: Cached[] = [];
  private ctx: CanvasRenderingContext2D | null = null;
  private scratch: OffscreenCanvas | null = null;
  private width = 0;
  private height = 0;
  /** The latest request: 'show' for jumps and scrubs, 'step' for frame steps. */
  private wanted: { t: number; fast: boolean; kind: 'show' | 'step' } | null = null;
  private busy = false;
  private stepTarget: number | null = null;
  private playToken = 0;
  private playing = false;
  private redraw: ReturnType<typeof setTimeout> | undefined;
  current: Frame | null = null;

  constructor(
    track: InputVideoTrack,
    private offset: number,
    private fps: number,
    private onFrame: (f: Frame) => void,
  ) {
    this.sink = new VideoSampleSink(track);
    this.packets = new EncodedPacketSink(track);
  }

  attach(canvas: HTMLCanvasElement): void {
    this.ctx = canvas.getContext('2d');
    this.resize(canvas.width, canvas.height);
  }

  /**
   * Canvas pixel size changed: cached frames at the old size are dropped. While paused,
   * the current frame is redrawn at the new size once resizing pauses (the caller keeps
   * a scaled copy on screen meanwhile); during playback new frames come at the new size.
   */
  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.clearCache();
    this.scratch = width && height ? new OffscreenCanvas(width, height) : null;
    clearTimeout(this.redraw);
    this.redraw = setTimeout(() => {
      if (this.current && !this.playing) this.show(this.current.ts);
    }, 200);
  }

  private clearCache(): void {
    for (const c of this.cache) c.bitmap.close();
    this.cache = [];
  }

  private get maxCached(): number {
    return Math.max(24, Math.floor(CACHE_BYTES / Math.max(1, this.width * this.height * 4)));
  }

  /** Show the frame on screen at time t. fast = nearest preceding keyframe (scrubbing). */
  show(t: number, fast = false): void {
    this.stepTarget = null;
    this.request(t, fast, 'show');
  }

  /** Step by whole frames; repeated calls (a held arrow key) accumulate and scrub. */
  step(n: number): void {
    const dur = this.current?.dur || 1 / this.fps;
    const base = this.stepTarget ?? this.current?.ts ?? 0;
    this.stepTarget = Math.max(0, base + n * dur);
    this.request(this.stepTarget, false, 'step');
  }

  private request(t: number, fast: boolean, kind: 'show' | 'step'): void {
    this.wanted = { t, fast, kind };
    if (!this.busy) void this.pump();
  }

  private async pump(): Promise<void> {
    this.busy = true;
    try {
      while (this.wanted) {
        const { t, fast } = this.wanted;
        this.wanted = null;
        const frame = fast ? await this.keyframe(t) : await this.exact(t);
        if (frame) {
          this.current = { ts: frame.ts, dur: frame.dur };
          this.ctx?.drawImage(frame.bitmap, 0, 0, this.width, this.height);
          // A frame overtaken by a newer jump mustn't move the playhead back (the user may
          // be about to press Set start). Steps toward a held-key target still report.
          if (!this.supersededByJump()) this.onFrame(this.current);
        }
      }
    } finally {
      this.busy = false;
      if (!this.wanted) this.stepTarget = null;
    }
  }

  /** A newer show() arrived while decoding (a method, so TypeScript doesn't narrow it away). */
  private supersededByJump(): boolean {
    return this.wanted?.kind === 'show';
  }

  private findCached(t: number): Cached | undefined {
    // A tiny tolerance so a target exactly on a frame boundary lands on that frame.
    return this.cache.find((c) => t >= c.ts - 1e-4 && t < c.ts + c.dur - 1e-4);
  }

  private store(sample: VideoSample): Cached | null {
    if (!this.scratch) return null;
    const ts = sample.timestamp - this.offset;
    const existing = this.cache.find((c) => Math.abs(c.ts - ts) < 1e-6);
    if (existing) return existing;
    const sctx = this.scratch.getContext('2d')!;
    sample.draw(sctx, 0, 0, this.width, this.height);
    const entry: Cached = { ts, dur: sample.duration || 1 / this.fps, bitmap: this.scratch.transferToImageBitmap() };
    this.cache.push(entry);
    return entry;
  }

  private evict(around: number): void {
    const max = this.maxCached;
    if (this.cache.length <= max) return;
    // Drop the frames furthest from where the user is.
    this.cache.sort((a, b) => Math.abs(a.ts - around) - Math.abs(b.ts - around));
    for (const c of this.cache.splice(max)) c.bitmap.close();
  }

  private async exact(t: number): Promise<Cached | null> {
    const hit = this.findCached(t);
    if (hit) return hit;
    const media = t + this.offset;
    const key = (await this.packets.getKeyPacket(media, { verifyKeyPackets: true })) ?? (await this.packets.getFirstPacket());
    if (!key) return null;
    // Presentation times of the frames from that keyframe to a little past t.
    const stamps: number[] = [];
    for (let p: typeof key | null = key; p && stamps.length < 1500; ) {
      stamps.push(p.timestamp);
      p = await this.packets.getNextPacket(p);
      if (p && p.type === 'key' && p.timestamp > media + AHEAD) break;
    }
    const keep = stamps.filter((s) => s >= media - BEHIND && s <= media + AHEAD).sort((a, b) => a - b);
    if (!keep.length) keep.push(media);
    for await (const sample of this.sink.samplesAtTimestamps(keep)) {
      if (!sample) continue;
      this.store(sample);
      sample.close();
      if (this.wanted && !this.wanted.fast && this.findCached(this.wanted.t)) break;
    }
    this.evict(t);
    return this.findCached(t) ?? this.nearest(t);
  }

  private nearest(t: number): Cached | null {
    let best: Cached | null = null;
    for (const c of this.cache) if (c.ts <= t + 1e-4 && (!best || c.ts > best.ts)) best = c;
    return best;
  }

  private async keyframe(t: number): Promise<Cached | null> {
    const key = await this.packets.getKeyPacket(t + this.offset, { verifyKeyPackets: true });
    if (!key) return this.exact(t);
    const cached = this.findCached(key.timestamp - this.offset);
    if (cached) return cached;
    const sample = await this.sink.getSample(key.timestamp);
    if (!sample) return null;
    const entry = this.store(sample);
    sample.close();
    this.evict(t);
    return entry;
  }

  /**
   * Play from time t, drawing each frame when clock() (app time) reaches it. Late frames
   * are dropped rather than slowing the clock down.
   */
  play(t: number, clock: () => number): void {
    const token = ++this.playToken;
    this.playing = true;
    const queue: VideoSample[] = [];
    let wake: (() => void) | null = null;
    const iterator = this.sink.samples(t + this.offset);
    void (async () => {
      try {
        for await (const sample of iterator) {
          if (token !== this.playToken) {
            sample.close();
            break;
          }
          queue.push(sample);
          while (queue.length >= PLAY_QUEUE && token === this.playToken) await new Promise<void>((r) => (wake = r));
        }
      } catch {
        // Playback stopped mid-decode.
      }
    })();
    const tick = () => {
      if (token !== this.playToken) {
        for (const s of queue.splice(0)) s.close();
        wake?.(); // let the decode loop see it should stop
        void iterator.return(undefined);
        return;
      }
      const now = clock() + this.offset;
      let show: VideoSample | undefined;
      while (queue.length && queue[0].timestamp <= now) {
        show?.close();
        show = queue.shift();
      }
      if (show) {
        if (this.ctx) show.draw(this.ctx, 0, 0, this.width, this.height);
        this.current = { ts: show.timestamp - this.offset, dur: show.duration || 1 / this.fps };
        show.close();
        this.onFrame(this.current);
        wake?.();
        wake = null;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  stop(): void {
    this.playToken++;
    this.playing = false;
  }

  dispose(): void {
    this.stop();
    clearTimeout(this.redraw);
    this.clearCache();
  }
}
