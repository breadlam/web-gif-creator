export type FontId = string;

export interface FontChoice {
  id: FontId;
  label: string;
  /** Family name inside the font file, which is what libass matches on. */
  family: string;
  bold: boolean;
  /** CSS family used for the HTML preview (declared in app.css or via FontFace). */
  css: string;
  /**
   * libass sizes text so that Fontsize = usWinAscent + usWinDescent, while CSS font-size
   * is the em size. cssPerAss = unitsPerEm / (winAscent + winDescent), from the font file.
   */
  cssPerAss: number;
  source: 'bundled' | 'embedded' | 'added';
  /** For bundled fonts: file name under public/fonts. */
  file?: string;
}

const BUNDLED: FontChoice[] = [
  { id: 'noto-bold', label: 'Noto Sans Bold', family: 'Noto Sans', bold: true, file: 'NotoSans-Bold.ttf', css: 'wgc-noto', cssPerAss: 0.6583, source: 'bundled' },
  { id: 'noto', label: 'Noto Sans', family: 'Noto Sans', bold: false, file: 'NotoSans-Regular.ttf', css: 'wgc-noto', cssPerAss: 0.6583, source: 'bundled' },
  { id: 'anton', label: 'Anton (meme style)', family: 'Anton', bold: false, file: 'Anton-Regular.ttf', css: 'wgc-anton', cssPerAss: 0.5769, source: 'bundled' },
];

/** Every font libass can use right now: bundled, embedded in the video, or added by the user. */
const registry: FontChoice[] = [...BUNDLED];

export function bundledFonts(): FontChoice[] {
  return BUNDLED;
}

export function allFonts(): FontChoice[] {
  return registry;
}

export function font(id: FontId): FontChoice {
  return registry.find((f) => f.id === id) ?? BUNDLED[0];
}

export function registerFont(f: FontChoice): void {
  if (!registry.some((x) => x.id === f.id)) registry.push(f);
}

export function unregisterFonts(source: FontChoice['source']): void {
  for (let i = registry.length - 1; i >= 0; i--) if (registry[i].source === source) registry.splice(i, 1);
}
