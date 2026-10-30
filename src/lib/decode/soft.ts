// Software decoding for the preview: FFmpeg's decoders in a worker, plugged into
// Mediabunny as custom decoders. They only take over configurations the browser's
// WebCodecs can't decode, so hardware decoding is used whenever it's available.

import {
  AudioSample, CustomAudioDecoder, CustomVideoDecoder, registerDecoder, VideoSample,
  type AudioCodec, type EncodedPacket, type VideoCodec,
} from 'mediabunny';
import type { DecodedFrame, WorkerReply, WorkerRequest } from './protocol';

/** FFmpeg decoder for each Mediabunny codec this build covers. */
const FFMPEG_NAME: Partial<Record<VideoCodec | AudioCodec, string>> = {
  avc: 'h264', hevc: 'hevc', vp8: 'vp8', vp9: 'vp9',
  aac: 'aac', opus: 'opus', mp3: 'mp3float', vorbis: 'vorbis', flac: 'flac',
  ac3: 'ac3', eac3: 'eac3', dts: 'dca',
};

type Pending = { resolve: (r: WorkerReply) => void; reject: (e: Error) => void };

class DecoderWorker {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private frameHandlers = new Map<number, (f: DecodedFrame) => void>();
  readonly ready: Promise<Record<string, boolean>>;

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<WorkerReply>) => {
      const msg = e.data;
      if (msg.type === 'frame') {
        this.frameHandlers.get(msg.handle)?.(msg);
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.type === 'error') p.reject(new Error(msg.message));
      else p.resolve(msg);
    };
    const url = new URL('decoders/decoder.mjs', document.baseURI).href;
    this.ready = this.request({ type: 'init', url, names: [...new Set(Object.values(FFMPEG_NAME))] }).then((r) => r.has ?? {});
  }

  request(req: DistributiveOmit<WorkerRequest, 'id'>, transfer: Transferable[] = []): Promise<Extract<WorkerReply, { type: 'ok' }>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as Pending['resolve'], reject });
      this.worker.postMessage({ ...req, id }, transfer);
    });
  }

  async open(req: Omit<Extract<WorkerRequest, { type: 'open' }>, 'id' | 'type'>, onFrame: (f: DecodedFrame) => void): Promise<number> {
    const transfer = req.extradata ? [req.extradata] : [];
    const { handle } = await this.request({ type: 'open', ...req }, transfer);
    this.frameHandlers.set(handle!, onFrame);
    return handle!;
  }

  decode(handle: number, packet: EncodedPacket): Promise<unknown> {
    // Copy: the packet's bytes may be a view into a buffer Mediabunny still uses.
    const data = packet.data.slice().buffer;
    return this.request({ type: 'decode', handle, data, ts: packet.timestamp, key: packet.type === 'key' }, [data]);
  }

  flush(handle: number): Promise<unknown> {
    return this.request({ type: 'flush', handle });
  }

  async close(handle: number): Promise<void> {
    await this.request({ type: 'close', handle });
    this.frameHandlers.delete(handle);
  }
}

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

let shared: DecoderWorker | null = null;
function worker(): DecoderWorker {
  shared ??= new DecoderWorker();
  return shared;
}

function bufferOf(src: AllowSharedBufferSource | undefined): ArrayBuffer | undefined {
  if (!src) return undefined;
  const view = ArrayBuffer.isView(src) ? new Uint8Array(src.buffer, src.byteOffset, src.byteLength) : new Uint8Array(src);
  return view.slice().buffer;
}

/** Decoder configs that must be decoded in software (WebCodecs can't, or failed). */
const software = new Set<string>();

function configKey(c: VideoDecoderConfig | AudioDecoderConfig): string {
  const desc = 'description' in c && c.description ? (c.description as ArrayBufferLike).byteLength ?? 0 : 0;
  return 'codedWidth' in c
    ? `v|${c.codec}|${c.codedWidth}x${c.codedHeight}|${desc}`
    : `a|${c.codec}|${(c as AudioDecoderConfig).sampleRate}|${(c as AudioDecoderConfig).numberOfChannels}|${desc}`;
}

export type DecodePath = 'browser' | 'software' | 'none';

/**
 * Decide how a track will be decoded, before Mediabunny creates its decoder: by the
 * browser if WebCodecs supports the config, otherwise by FFmpeg in a worker if this
 * build has the codec.
 */
export async function chooseDecodePath(
  codec: VideoCodec | AudioCodec | null,
  config: VideoDecoderConfig | AudioDecoderConfig | null,
): Promise<DecodePath> {
  if (!codec || !config) return 'none';
  if (codec.startsWith('pcm') || codec === 'ulaw' || codec === 'alaw') return 'browser'; // Mediabunny decodes PCM itself
  if (!software.has(configKey(config))) {
    try {
      const native = 'codedWidth' in config
        ? typeof VideoDecoder !== 'undefined' && (await VideoDecoder.isConfigSupported(config)).supported
        : typeof AudioDecoder !== 'undefined' && (await AudioDecoder.isConfigSupported(config as AudioDecoderConfig)).supported;
      if (native) return 'browser';
    } catch {
      // Treat a rejected check as unsupported.
    }
  }
  const name = FFMPEG_NAME[codec];
  if (!name || !(await worker().ready)[name]) return 'none';
  software.add(configKey(config));
  return 'software';
}

/** After the browser failed to decode a config it claimed to support, use software. */
export function forceSoftware(config: VideoDecoderConfig | AudioDecoderConfig): void {
  software.add(configKey(config));
}

class SoftVideoDecoder extends CustomVideoDecoder {
  private handle = 0;
  /** Packet durations by microsecond timestamp; frames come out without one. */
  private durations = new Map<number, number>();

  static override supports(codec: VideoCodec, config: VideoDecoderConfig): boolean {
    return !!FFMPEG_NAME[codec] && software.has(configKey(config));
  }

  async init() {
    this.handle = await worker().open(
      { kind: 'video', codec: FFMPEG_NAME[this.codec]!, extradata: bufferOf(this.config.description), width: this.config.codedWidth, height: this.config.codedHeight },
      (f) => {
        if (f.kind !== 'video') return;
        const key = Math.round(f.ts * 1e6);
        const duration = this.durations.get(key);
        this.durations.delete(key);
        this.onSample(new VideoSample(new Uint8Array(f.data), {
          format: 'I420', codedWidth: f.width, codedHeight: f.height, timestamp: f.ts, duration,
        }));
      },
    );
  }

  async decode(packet: EncodedPacket) {
    this.durations.set(packet.microsecondTimestamp, packet.duration);
    await worker().decode(this.handle, packet);
  }

  async flush() {
    await worker().flush(this.handle);
    this.durations.clear();
  }

  async close() {
    await worker().close(this.handle);
  }
}

class SoftAudioDecoder extends CustomAudioDecoder {
  private handle = 0;

  static override supports(codec: AudioCodec, config: AudioDecoderConfig): boolean {
    return !!FFMPEG_NAME[codec] && software.has(configKey(config));
  }

  async init() {
    this.handle = await worker().open(
      { kind: 'audio', codec: FFMPEG_NAME[this.codec]!, extradata: bufferOf(this.config.description), rate: this.config.sampleRate, channels: this.config.numberOfChannels },
      (f) => {
        if (f.kind !== 'audio' || f.samples === 0) return;
        this.onSample(new AudioSample({
          data: new Float32Array(f.data), format: 'f32-planar', numberOfChannels: f.channels, sampleRate: f.rate, timestamp: f.ts,
        }));
      },
    );
  }

  async decode(packet: EncodedPacket) {
    await worker().decode(this.handle, packet);
  }

  async flush() {
    await worker().flush(this.handle);
  }

  async close() {
    await worker().close(this.handle);
  }
}

registerDecoder(SoftVideoDecoder);
registerDecoder(SoftAudioDecoder);
