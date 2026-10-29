import { assColor, assTime, escapeAssText, type Cue, type TextOverlay } from './ass';
import { font } from './fonts';
import type { SubtitleTrack } from './probe';

/** How subtitle lines go into the GIF. */
export type SubtitleMode = 'off' | 'original' | 'custom';

/** Shared style for subtitle lines in 'custom' mode. (x, y) is the bottom centre of the block. */
export type SubtitleStyle = Pick<TextOverlay, 'font' | 'size' | 'color' | 'outlineColor' | 'outline' | 'x' | 'y'>;

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  font: 'noto-bold', size: 7.5, color: '#ffffff', outlineColor: '#000000', outline: 0.5, x: 0.5, y: 0.94,
};

/** Rough stand-in for typical ASS styling, for previewing 'original' mode in HTML. */
export const ORIGINAL_PREVIEW_STYLE: SubtitleStyle = { ...DEFAULT_SUBTITLE_STYLE, font: 'noto', size: 6.5, outline: 0.4 };

const SIGNS_LIKE = /sign|song|lyric|karaoke|forced|commentary/i;

export function overlapping(cues: Cue[], start: number, end: number): Cue[] {
  return cues.filter((c) => c.end > start && c.start < end);
}

export function activeAt(cues: Cue[], t: number): Cue[] {
  return cues.filter((c) => t >= c.start && t < c.end);
}

export function cueText(c: Cue, overrides: Record<number, string>): string {
  return overrides[c.line] ?? c.text;
}

/** Case-insensitive substring search over cue text. */
export function searchCues(cues: Cue[], query: string, limit = 50): Cue[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return cues.filter((c) => c.text.toLowerCase().includes(q)).slice(0, limit);
}

/** Cues nearest a time, in time order, for browsing while scrubbing. */
export function nearby(cues: Cue[], t: number, count = 8): Cue[] {
  return [...cues]
    .sort((a, b) => Math.abs((a.start + a.end) / 2 - t) - Math.abs((b.start + b.end) / 2 - t))
    .slice(0, count)
    .sort((a, b) => a.start - b.start);
}

/**
 * Track to select by default: prefer the browser's language, then tracks that aren't
 * signs/songs/forced, then the one with the most lines.
 */
export function bestTrack(tracks: SubtitleTrack[], lineCounts: Record<number, number>, language: string): number | null {
  const lang = language.toLowerCase().slice(0, 2);
  const score = (t: SubtitleTrack) =>
    (t.language.toLowerCase().startsWith(lang) || LANG3[t.language]?.startsWith(lang) ? 1e7 : 0) +
    (SIGNS_LIKE.test(t.title) || t.forced ? 0 : 1e6) +
    (lineCounts[t.index] ?? 0);
  const usable = tracks.filter((t) => (lineCounts[t.index] ?? 0) > 0);
  if (usable.length === 0) return null;
  return usable.reduce((a, b) => (score(b) > score(a) ? b : a)).index;
}

// ISO 639-2 codes used in MKV tags, mapped to the two-letter codes browsers report.
const LANG3: Record<string, string> = {
  eng: 'en', jpn: 'ja', spa: 'es', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', ita: 'it', por: 'pt',
  rus: 'ru', chi: 'zh', zho: 'zh', kor: 'ko', ara: 'ar', dut: 'nl', nld: 'nl', pol: 'pl', swe: 'sv',
};

/** Replace the text of edited Dialogue lines (dropping their inline override tags). */
export function applyOverrides(ass: string, overrides: Record<number, string>): string {
  const lines = Object.keys(overrides).map(Number);
  if (lines.length === 0) return ass;
  const out = ass.split('\n');
  let fields = 10;
  let section = '';
  out.forEach((raw, i) => {
    const t = raw.trim();
    if (t.startsWith('[')) section = t.toLowerCase();
    else if (section === '[events]' && /^format:/i.test(t)) fields = t.split(',').length;
    else if (i in overrides && /^\s*(dialogue|comment):/i.test(raw)) {
      const colon = raw.indexOf(':');
      const parts = raw.slice(colon + 1).split(',');
      out[i] = `${raw.slice(0, colon + 1)}${parts.slice(0, fields - 1).join(',')},${escapeAssText(overrides[i])}`;
    }
  });
  return out.join('\n');
}

/**
 * ASS for 'custom' mode. Lines use bottom-centre alignment with margins rather than
 * \pos, so libass stacks lines that overlap in time instead of drawing them on top of
 * each other. MarginV puts the block's bottom at y; MarginL/MarginR centre it on x.
 */
export function buildSubtitleAss(
  cues: Cue[], overrides: Record<number, string>, style: SubtitleStyle, width: number, height: number,
): string {
  const f = font(style.font);
  const size = Math.max(1, Math.round((style.size / 100) * height));
  const outline = Math.round((style.outline / 100) * height * 10) / 10;
  const cx = style.x * width;
  const marginL = Math.max(0, Math.round(2 * cx - width));
  const marginR = Math.max(0, Math.round(width - 2 * cx));
  const marginV = Math.max(0, Math.round(height - style.y * height));
  const events = cues
    .filter((c) => cueText(c, overrides).trim())
    .map((c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Sub,,0,0,0,,${escapeAssText(cueText(c, overrides))}`);
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
    `Style: Sub,${f.family},${size},${assColor(style.color)},&H000000FF,${assColor(style.outlineColor)},&H00000000,` +
      `${f.bold ? -1 : 0},0,0,0,100,100,0,0,1,${outline},0,2,${marginL},${marginR},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}
