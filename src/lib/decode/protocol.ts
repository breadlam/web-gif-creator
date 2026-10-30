// Messages between the main thread and the decoder worker.

export type WorkerRequest =
  | { type: 'init'; id: number; url: string; names: string[] }
  | {
      type: 'open';
      id: number;
      kind: 'video' | 'audio';
      /** FFmpeg decoder name. */
      codec: string;
      extradata?: ArrayBuffer;
      width?: number;
      height?: number;
      rate?: number;
      channels?: number;
    }
  | { type: 'decode'; id: number; handle: number; data: ArrayBuffer; ts: number; key: boolean }
  | { type: 'flush'; id: number; handle: number }
  | { type: 'close'; id: number; handle: number };

export type DecodedFrame =
  | { kind: 'video'; data: ArrayBuffer; ts: number; width: number; height: number }
  | { kind: 'audio'; data: ArrayBuffer; ts: number; samples: number; channels: number; rate: number };

export type WorkerReply =
  | { type: 'ok'; id: number; handle?: number; has?: Record<string, boolean> }
  | { type: 'error'; id: number; message: string }
  | ({ type: 'frame'; id: number; handle: number } & DecodedFrame);
