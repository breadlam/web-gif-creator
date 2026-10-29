import { font, type FontId } from './fonts';

export interface TextOverlay {
  id: string;
  text: string;
  font: FontId;
  /** Font size as a percentage of the GIF height (ASS Fontsize semantics). */
  size: number;
  color: string;
  outlineColor: string;
  /** Outline width as a percentage of the GIF height. */
  outline: number;
  /** Anchor (text centre) as a fraction of width/height. */
  x: number;
  y: number;
  /** Source-video times in seconds. */
  start: number;
  end: number;
}

export interface Cue {
  /** Line number in the ASS file, used to toggle the cue. */
  line: number;
  start: number;
  end: number;
  text: string;
}

/** #rrggbb -> &HAABBGGRR (alpha 00 = opaque). */
export function assColor(hex: string, alpha = 0): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  const [r, g, b] = m ? [m[1], m[2], m[3]] : ['ff', 'ff', 'ff'];
  const a = alpha.toString(16).padStart(2, '0');
  return `&H${a}${b}${g}${r}`.toUpperCase();
}

/** Seconds -> H:MM:SS.cc */
export function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

export function parseAssTime(t: string): number {
  const m = /^(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d+))?$/.exec(t.trim());
  if (!m) return NaN;
  const frac = m[4] ? parseInt(m[4], 10) / 10 ** m[4].length : 0;
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + frac;
}

/** Make user text safe for an ASS Dialogue line. */
export function escapeAssText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    // Braces open override blocks and have no portable escape; use full-width forms.
    .replace(/\{/g, '｛')
    .replace(/\}/g, '｝')
    // Break up \n, \N and \h so a literal backslash isn't read as an escape.
    .replace(/\\(?=[nNh])/g, '\\​')
    .replace(/\n/g, '\\N');
}

export function buildOverlayAss(overlays: TextOverlay[], width: number, height: number): string {
  const styles: string[] = [];
  const events: string[] = [];
  overlays.forEach((o, i) => {
    if (!o.text.trim() || o.end <= o.start) return;
    const f = font(o.font);
    const size = Math.max(1, Math.round((o.size / 100) * height));
    const outline = Math.round((o.outline / 100) * height * 10) / 10;
    styles.push(
      `Style: O${i},${f.family},${size},${assColor(o.color)},&H000000FF,${assColor(o.outlineColor)},&H00000000,` +
        `${f.bold ? -1 : 0},0,0,0,100,100,0,0,1,${outline},0,5,0,0,0,1`,
    );
    const x = Math.round(o.x * width);
    const y = Math.round(o.y * height);
    events.push(`Dialogue: 0,${assTime(o.start)},${assTime(o.end)},O${i},,0,0,0,,{\\pos(${x},${y})}${escapeAssText(o.text)}`);
  });
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: None',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styles,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}

/** Strip override tags and convert ASS line breaks for display. */
export function plainText(assText: string): string {
  return assText
    .replace(/\{[^}]*\}/g, '')
    .replace(/\\[Nn]/g, '\n')
    .replace(/\\h/g, ' ')
    .trim();
}

/** Dialogue lines of an ASS file, using its own [Events] Format line. */
export function parseAssCues(ass: string): Cue[] {
  const lines = ass.split(/\r?\n/);
  let inEvents = false;
  let fields = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
  const cues: Cue[] = [];
  lines.forEach((raw, line) => {
    const l = raw.trim();
    if (l.startsWith('[')) {
      inEvents = l.toLowerCase() === '[events]';
      return;
    }
    if (!inEvents) return;
    if (/^format:/i.test(l)) {
      fields = l.slice(7).split(',').map((s) => s.trim().toLowerCase());
      return;
    }
    if (!/^dialogue:/i.test(l)) return;
    const body = l.slice(9).trimStart();
    // Text is the last field and may itself contain commas.
    const parts = body.split(',');
    const head = parts.slice(0, fields.length - 1);
    const text = parts.slice(fields.length - 1).join(',');
    const get = (name: string) => head[fields.indexOf(name)] ?? '';
    const start = parseAssTime(get('start'));
    const end = parseAssTime(get('end'));
    if (Number.isNaN(start) || Number.isNaN(end)) return;
    cues.push({ line, start, end, text: plainText(text) });
  });
  return cues;
}

/** Turn the given Dialogue lines into Comment lines so libass skips them. */
export function disableCues(ass: string, lines: Set<number>): string {
  if (lines.size === 0) return ass;
  return ass
    .split('\n')
    .map((l, i) => (lines.has(i) ? l.replace(/^(\s*)Dialogue:/i, '$1Comment:') : l))
    .join('\n');
}
