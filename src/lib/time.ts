/** Format seconds as h:mm:ss.mmm (hours omitted when zero). */
export function formatTime(sec: number, decimals = 3): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const scale = 10 ** decimals;
  const total = Math.round(sec * scale);
  const frac = total % scale;
  const s = Math.floor(total / scale);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const fracStr = decimals > 0 ? '.' + String(frac).padStart(decimals, '0') : '';
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return (h > 0 ? `${h}:` : '') + `${mm}:${String(ss).padStart(2, '0')}${fracStr}`;
}

/** Parse "83.5", "1:23.5" or "0:01:23.5". Returns null for anything else. */
export function parseTime(text: string): number | null {
  const t = text.trim();
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(t)) return null;
  const parts = t.split(':');
  let sec = 0;
  for (const p of parts) sec = sec * 60 + parseFloat(p);
  return sec;
}

/** Filename-safe time, e.g. 83.25 -> "1m23.25s". */
export function compactTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = (sec - m * 60).toFixed(2).replace(/\.?0+$/, '');
  return m > 0 ? `${m}m${s}s` : `${s}s`;
}

/** Seconds with millisecond precision, for ffmpeg arguments. */
export function ffTime(sec: number): string {
  return Math.max(0, sec).toFixed(3);
}
