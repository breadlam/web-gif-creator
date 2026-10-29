import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg';

export interface ExecResult {
  code: number;
  lines: string[];
}

export class Cancelled extends Error {
  constructor() {
    super('Cancelled');
  }
}

/**
 * Wrapper around one ffmpeg.wasm instance. Operations are serialised (the wasm core
 * runs one command at a time). Every file written is remembered so that after a
 * cancel (which kills the worker) the next operation can rebuild the filesystem.
 */
export class Engine {
  private ready: Promise<FFmpeg> | null = null;
  private ff: FFmpeg | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private input: { data: Blob; name: string } | null = null;
  private files = new Map<string, Uint8Array>();
  private listeners = new Set<(line: string) => void>();
  private generation = 0;

  /** Subscribe to every ffmpeg log line. Returns an unsubscribe function. */
  onLog(fn: (line: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  load(): Promise<void> {
    return this.instance().then(() => undefined);
  }

  private instance(): Promise<FFmpeg> {
    this.ready ??= this.boot().catch((e) => {
      this.ready = null;
      throw e;
    });
    return this.ready;
  }

  private async boot(): Promise<FFmpeg> {
    const ff = new FFmpeg();
    ff.on('log', ({ message }) => this.listeners.forEach((l) => l(message)));
    const base = new URL('ffmpeg-core/', document.baseURI).href;
    await ff.load({ coreURL: `${base}ffmpeg-core.js`, wasmURL: `${base}ffmpeg-core.wasm` });
    for (const dir of ['/work', '/fonts', '/input']) await ff.createDir(dir).catch(() => undefined);
    // writeFile transfers the buffer to the worker, so always send a copy.
    for (const [path, data] of this.files) await ff.writeFile(path, data.slice());
    if (this.input) await ff.mount(FFFSType.WORKERFS, { blobs: [this.input] }, '/input');
    this.ff = ff;
    return ff;
  }

  private enqueue<T>(fn: (ff: FFmpeg) => Promise<T>): Promise<T> {
    const gen = this.generation;
    const run = this.chain.then(async () => {
      if (gen !== this.generation) throw new Cancelled();
      return fn(await this.instance());
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Mount a file read-only (WORKERFS: no copy into wasm memory). Returns its path. */
  setInput(file: File): Promise<string> {
    const ext = /\.[a-z0-9]{1,5}$/i.exec(file.name)?.[0].toLowerCase() ?? '';
    const name = `input${ext}`;
    return this.enqueue(async (ff) => {
      if (this.input) await ff.unmount('/input').catch(() => undefined);
      this.input = { data: file, name };
      await ff.mount(FFFSType.WORKERFS, { blobs: [this.input] }, '/input');
      return `/input/${name}`;
    });
  }

  exec(args: string[], onLine?: (line: string) => void): Promise<ExecResult> {
    return this.enqueue((ff) => this.capture(onLine, () => ff.exec(args)));
  }

  ffprobe(args: string[]): Promise<ExecResult> {
    return this.enqueue((ff) => this.capture(undefined, () => ff.ffprobe(args)));
  }

  private async capture(onLine: ((line: string) => void) | undefined, run: () => Promise<number>): Promise<ExecResult> {
    const lines: string[] = [];
    const off = this.onLog((l) => {
      lines.push(l);
      onLine?.(l);
    });
    try {
      const code = await run();
      return { code, lines };
    } catch (e) {
      if (this.ff === null) throw new Cancelled();
      throw e;
    } finally {
      off();
    }
  }

  write(path: string, data: Uint8Array | string): Promise<void> {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    this.files.set(path, bytes);
    return this.enqueue(async (ff) => {
      await ff.writeFile(path, bytes.slice());
    });
  }

  read(path: string): Promise<Uint8Array> {
    return this.enqueue(async (ff) => (await ff.readFile(path)) as Uint8Array);
  }

  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.read(path));
  }

  exists(path: string): Promise<boolean> {
    const dir = path.slice(0, path.lastIndexOf('/')) || '/';
    const name = path.slice(path.lastIndexOf('/') + 1);
    return this.enqueue(async (ff) => (await ff.listDir(dir)).some((n) => n.name === name));
  }

  list(dir: string): Promise<string[]> {
    return this.enqueue(async (ff) => (await ff.listDir(dir)).filter((n) => !n.isDir).map((n) => n.name));
  }

  remove(path: string): Promise<void> {
    this.files.delete(path);
    return this.enqueue(async (ff) => {
      await ff.deleteFile(path).catch(() => undefined);
    });
  }

  /** Kill the running command. Queued operations are dropped; later ones reload ffmpeg. */
  cancel(): void {
    this.generation++;
    this.ff?.terminate();
    this.ff = null;
    this.ready = null;
  }
}

export const engine = new Engine();
