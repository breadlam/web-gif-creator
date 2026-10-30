/// <reference lib="webworker" />
// Runs FFmpeg's decoders (public/decoders/decoder.wasm, built by tools/decoders) off the
// main thread. Each request carries an id; the reply echoes it. Decoded frames are
// posted as they come out, with their buffers transferred.

import type { WorkerReply, WorkerRequest } from './protocol';

interface DecoderModule {
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
  stringToNewUTF8(s: string): number;
  _dec_has(name: number): number;
  _dec_open(name: number, extra: number, extraSize: number, w: number, h: number, rate: number, channels: number): number;
  _dec_send(d: number, data: number, size: number, ptsUs: number, key: number): number;
  _dec_flush(d: number): number;
  _dec_reset(d: number): void;
  _dec_receive(d: number): number;
  _dec_close(d: number): void;
  _dec_out(d: number): number;
  _dec_out_size(d: number): number;
  _dec_width(d: number): number;
  _dec_height(d: number): number;
  _dec_samples(d: number): number;
  _dec_channels(d: number): number;
  _dec_rate(d: number): number;
  _dec_pts(d: number): number;
}

let mod: DecoderModule | null = null;
const decoders = new Map<number, { ptr: number; kind: 'video' | 'audio' }>();
let nextHandle = 1;
let inPtr = 0;
let inCap = 0;

const post = (msg: WorkerReply, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

function withString<T>(s: string, fn: (ptr: number) => T): T {
  const ptr = mod!.stringToNewUTF8(s);
  try {
    return fn(ptr);
  } finally {
    mod!._free(ptr);
  }
}

function copyIn(data: Uint8Array): number {
  if (data.length > inCap) {
    if (inPtr) mod!._free(inPtr);
    inCap = Math.max(data.length, inCap * 2, 1 << 16);
    inPtr = mod!._malloc(inCap);
  }
  mod!.HEAPU8.set(data, inPtr);
  return inPtr;
}

/** Receive every frame the decoder has ready and post them. Returns false at end of stream. */
function drain(handle: number, id: number): void {
  const m = mod!;
  const d = decoders.get(handle)!;
  for (;;) {
    const r = m._dec_receive(d.ptr);
    if (r === 0 || r === -2) return;
    if (r < 0) throw new Error(`decode error ${r}`);
    const out = m._dec_out(d.ptr);
    const size = m._dec_out_size(d.ptr);
    const data = m.HEAPU8.slice(out, out + size).buffer;
    const ts = m._dec_pts(d.ptr);
    if (d.kind === 'video') {
      post({ type: 'frame', id, handle, kind: 'video', data, ts, width: m._dec_width(d.ptr), height: m._dec_height(d.ptr) }, [data]);
    } else {
      post({ type: 'frame', id, handle, kind: 'audio', data, ts, samples: m._dec_samples(d.ptr), channels: m._dec_channels(d.ptr), rate: m._dec_rate(d.ptr) }, [data]);
    }
  }
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  try {
    switch (req.type) {
      case 'init': {
        const { default: create } = await import(/* @vite-ignore */ req.url);
        mod = (await create()) as DecoderModule;
        const has = Object.fromEntries(req.names.map((n) => [n, withString(n, (p) => mod!._dec_has(p)) === 1]));
        post({ type: 'ok', id: req.id, has });
        break;
      }
      case 'open': {
        const m = mod!;
        let extraPtr = 0;
        if (req.extradata) {
          extraPtr = m._malloc(req.extradata.byteLength);
          m.HEAPU8.set(new Uint8Array(req.extradata), extraPtr);
        }
        const ptr = withString(req.codec, (name) =>
          m._dec_open(name, extraPtr, req.extradata?.byteLength ?? 0, req.width ?? 0, req.height ?? 0, req.rate ?? 0, req.channels ?? 0),
        );
        if (extraPtr) m._free(extraPtr);
        if (!ptr) throw new Error(`could not open the ${req.codec} decoder`);
        const handle = nextHandle++;
        decoders.set(handle, { ptr, kind: req.kind });
        post({ type: 'ok', id: req.id, handle });
        break;
      }
      case 'decode': {
        const d = decoders.get(req.handle);
        if (!d) throw new Error('decoder closed');
        const data = new Uint8Array(req.data);
        const ptr = copyIn(data);
        for (;;) {
          const r = mod!._dec_send(d.ptr, ptr, data.length, req.ts * 1e6, req.key ? 1 : 0);
          // Corrupt packets are skipped rather than failing the stream.
          if (r === 1) drain(req.handle, req.id);
          else {
            drain(req.handle, req.id);
            break;
          }
        }
        post({ type: 'ok', id: req.id });
        break;
      }
      case 'flush': {
        const d = decoders.get(req.handle)!;
        mod!._dec_flush(d.ptr);
        drain(req.handle, req.id);
        mod!._dec_reset(d.ptr);
        post({ type: 'ok', id: req.id });
        break;
      }
      case 'close': {
        const d = decoders.get(req.handle);
        if (d) mod!._dec_close(d.ptr);
        decoders.delete(req.handle);
        post({ type: 'ok', id: req.id });
        break;
      }
    }
  } catch (err) {
    post({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err) });
  }
};
