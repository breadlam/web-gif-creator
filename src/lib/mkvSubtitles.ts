// Reads text subtitle tracks straight out of a Matroska/WebM file in JavaScript: one pass
// in large chunks, keeping only the subtitle tracks' blocks. Much faster than ffmpeg.wasm,
// which reads the whole file through the browser in 32 KB pieces.
//
// Output matches what `ffmpeg -c:s copy|ass out.ass` would write: an ASS script per
// track, keyed by track position among subtitle tracks (ffprobe's order).

import { assTime } from './ass';

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
};
/** Top-level Segment children; seeing one ends an unknown-size Cluster. */
const TOP_LEVEL = new Set([0x114d9b74, ID.Info, ID.Tracks, ID.Cluster, 0x1c53bb6b, 0x1941a469, 0x1043a770, 0x1254c367]);
const UNKNOWN = -1;
const CHUNK = 8 * 1024 * 1024;

export const MKV_TEXT_CODECS = new Set(['S_TEXT/ASS', 'S_TEXT/SSA', 'S_ASS', 'S_SSA', 'S_TEXT/UTF8', 'S_TEXT/WEBVTT']);

interface SubTrack {
  number: number;
  codec: string;
  header: string;
  events: { order: number; start: number; end: number; payload: string }[];
}

/** Sequential reader over a Blob, fetching CHUNK bytes at a time. */
class Reader {
  private buf = new Uint8Array(0);
  private bufStart = 0;
  constructor(private blob: Blob) {}

  get size(): number {
    return this.blob.size;
  }

  async bytes(pos: number, n: number): Promise<Uint8Array> {
    if (pos < this.bufStart || pos + n > this.bufStart + this.buf.length) {
      const end = Math.min(this.blob.size, pos + Math.max(n, CHUNK));
      this.buf = new Uint8Array(await this.blob.slice(pos, end).arrayBuffer());
      this.bufStart = pos;
    }
    return this.buf.subarray(pos - this.bufStart, pos - this.bufStart + n);
  }
}

/** EBML variable-length integer at the start of `b`. */
function vint(b: Uint8Array, keepMarker: boolean): { value: number; length: number } {
  const first = b[0];
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  if (length > 8) throw new Error('invalid EBML length');
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === (0xff >> length);
  for (let i = 1; i < length; i++) {
    value = value * 256 + b[i];
    if (b[i] !== 0xff) allOnes = false;
  }
  return { value: !keepMarker && allOnes ? UNKNOWN : value, length };
}

async function element(r: Reader, pos: number): Promise<{ id: number; size: number; data: number }> {
  const head = await r.bytes(pos, Math.min(12, r.size - pos));
  const id = vint(head, true);
  const size = vint(head.subarray(id.length), false);
  return { id: id.value, size: size.value, data: pos + id.length + size.length };
}

const uint = (b: Uint8Array) => b.reduce((v, x) => v * 256 + x, 0);
const text = (b: Uint8Array) => new TextDecoder().decode(b).replace(/\0+$/, '');

async function children(r: Reader, start: number, end: number, fn: (e: { id: number; size: number; data: number }) => Promise<void> | void) {
  for (let pos = start; pos < end; ) {
    const e = await element(r, pos);
    await fn(e);
    if (e.size === UNKNOWN) break;
    pos = e.data + e.size;
  }
}

/**
 * Extract every text subtitle track. onProgress gets the fraction of the file read.
 * Returns null if the file isn't Matroska/WebM.
 */
export async function extractMkvSubtitles(blob: Blob, onProgress?: (fraction: number) => void): Promise<string[] | null> {
  const r = new Reader(blob);
  const ebml = await element(r, 0).catch(() => null);
  if (!ebml || ebml.id !== ID.EBML) return null;
  const seg = await element(r, ebml.data + ebml.size);
  if (seg.id !== ID.Segment) return null;
  const segEnd = seg.size === UNKNOWN ? r.size : Math.min(r.size, seg.data + seg.size);

  let scale = 1_000_000; // ns per timecode unit
  const tracks = new Map<number, SubTrack>();
  const order: SubTrack[] = [];
  let firstTime = Infinity;
  let lastReport = 0;

  const block = (b: Uint8Array, cluster: number, duration: number | null) => {
    const tn = vint(b, false);
    const track = tracks.get(tn.value);
    const rel = (b[tn.length] << 24) >> 16 | b[tn.length + 1]; // int16
    const time = ((cluster + rel) * scale) / 1e9;
    if (time < firstTime) firstTime = time;
    if (!track) return;
    const flags = b[tn.length + 2];
    if (flags & 0x06) return; // laced: never used for subtitles
    const payload = text(b.subarray(tn.length + 3));
    const end = duration === null ? time + 5 : time + (duration * scale) / 1e9;
    track.events.push({ order: track.events.length, start: time, end, payload });
  };

  for (let pos = seg.data; pos < segEnd; ) {
    const e = await element(r, pos);
    if (e.id === ID.Info) {
      await children(r, e.data, e.data + e.size, async (c) => {
        if (c.id === ID.TimecodeScale) scale = uint(await r.bytes(c.data, c.size));
      });
    } else if (e.id === ID.Tracks) {
      await children(r, e.data, e.data + e.size, async (t) => {
        if (t.id !== ID.TrackEntry) return;
        const entry = { number: 0, type: 0, codec: '', header: '' };
        await children(r, t.data, t.data + t.size, async (f) => {
          const v = await r.bytes(f.data, f.size);
          if (f.id === ID.TrackNumber) entry.number = uint(v);
          else if (f.id === ID.TrackType) entry.type = uint(v);
          else if (f.id === ID.CodecID) entry.codec = text(v);
          else if (f.id === ID.CodecPrivate) entry.header = text(v);
        });
        if (entry.type !== 0x11) return;
        const track: SubTrack = { number: entry.number, codec: entry.codec, header: entry.header, events: [] };
        order.push(track);
        if (MKV_TEXT_CODECS.has(entry.codec)) tracks.set(entry.number, track);
      });
      if (tracks.size === 0) return order.map(() => '');
    } else if (e.id === ID.Cluster) {
      let tc = 0;
      const end = e.size === UNKNOWN ? segEnd : e.data + e.size;
      let p = e.data;
      while (p < end) {
        const c = await element(r, p);
        if (e.size === UNKNOWN && TOP_LEVEL.has(c.id)) break;
        if (c.id === ID.Timecode) tc = uint(await r.bytes(c.data, c.size));
        else if (c.id === ID.SimpleBlock) {
          // Only the header is needed to know the track; read the rest only for ours.
          const head = await r.bytes(c.data, Math.min(c.size, 8));
          if (tracks.has(vint(head, false).value) || firstTime === Infinity) block(await r.bytes(c.data, c.size), tc, null);
        } else if (c.id === ID.BlockGroup) {
          let data: Uint8Array | null = null;
          let duration: number | null = null;
          await children(r, c.data, c.data + c.size, async (g) => {
            if (g.id === ID.Block) {
              const head = await r.bytes(g.data, Math.min(g.size, 8));
              if (tracks.has(vint(head, false).value) || firstTime === Infinity) data = (await r.bytes(g.data, g.size)).slice();
            } else if (g.id === ID.BlockDuration) duration = uint(await r.bytes(g.data, g.size));
          });
          if (data) block(data, tc, duration);
        }
        if (c.size === UNKNOWN) break;
        p = c.data + c.size;
      }
      // An unknown-size cluster ends where the next top-level element starts.
      pos = e.size === UNKNOWN ? p : end;
      if (onProgress && pos - lastReport > CHUNK * 4) {
        lastReport = pos;
        onProgress(pos / segEnd);
      }
      continue;
    }
    if (e.size === UNKNOWN) break;
    pos = e.data + e.size;
  }

  const offset = Number.isFinite(firstTime) ? Math.max(0, firstTime) : 0;
  return order.map((t) => (MKV_TEXT_CODECS.has(t.codec) ? toAss(t, offset) : ''));
}

function toAss(t: SubTrack, offset: number): string {
  const events = [...t.events].sort((a, b) => a.start - b.start || a.order - b.order);
  if (t.codec === 'S_TEXT/UTF8' || t.codec === 'S_TEXT/WEBVTT') {
    return [
      '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 384', 'PlayResY: 288', 'ScaledBorderAndShadow: yes', '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      'Style: Default,Arial,16,&Hffffff,&Hffffff,&H0,&H0,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,0', '',
      '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      ...events.map((e) => `Dialogue: 0,${assTime(e.start - offset)},${assTime(e.end - offset)},Default,,0,0,0,,${htmlToAss(e.payload)}`),
      '',
    ].join('\n');
  }
  // ASS/SSA: CodecPrivate is the script header; each block is "ReadOrder,<the Format
  // fields except Start and End>". Rebuild Dialogue lines in the header's Format order.
  const header = t.header.replace(/\r\n?/g, '\n').trimEnd();
  const headerLines = header.split('\n').map((l) => l.trim());
  const eventsAt = headerLines.findIndex((l) => l.toLowerCase() === '[events]');
  const formatLine = eventsAt < 0 ? undefined : headerLines.slice(eventsAt + 1).find((l) => /^format:/i.test(l));
  const fields = (formatLine ?? 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text')
    .slice(7).split(',').map((f) => f.trim().toLowerCase());
  const rest = fields.filter((f) => f !== 'start' && f !== 'end');
  const lines = events
    .map((e) => {
      const parts = e.payload.split(',');
      const order = parseInt(parts[0], 10);
      const values = parts.slice(1, rest.length);
      values.push(parts.slice(rest.length).join(','));
      const byName = new Map(rest.map((f, i) => [f, values[i] ?? '']));
      byName.set('start', assTime(e.start - offset));
      byName.set('end', assTime(e.end - offset));
      return { order: Number.isNaN(order) ? e.order : order, start: e.start, line: `Dialogue: ${fields.map((f) => byName.get(f) ?? '').join(',')}` };
    })
    .sort((a, b) => a.start - b.start || a.order - b.order)
    .map((x) => x.line);
  const missing = eventsAt < 0 ? ['', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'] : [];
  return [header, ...missing, ...lines, ''].join('\n');
}

/** SRT/WebVTT inline markup to ASS overrides. */
function htmlToAss(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/<(\/?)([ibu])>/gi, (_, close: string, tag: string) => `{\\${tag.toLowerCase()}${close ? 0 : 1}}`)
    .replace(/<[^>]+>/g, '')
    .replace(/\n/g, '\\N');
}
