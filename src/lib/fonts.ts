export type FontId = 'noto' | 'noto-bold' | 'anton';

export interface BundledFont {
  id: FontId;
  label: string;
  /** Family name inside the font file, which is what libass matches on. */
  family: string;
  bold: boolean;
  file: string;
  /** CSS family declared in app.css for the HTML preview. */
  css: string;
  /**
   * libass sizes text so that Fontsize = usWinAscent + usWinDescent, while CSS font-size
   * is the em size. cssPerAss = unitsPerEm / (winAscent + winDescent), from the font files.
   */
  cssPerAss: number;
}

export const FONTS: BundledFont[] = [
  { id: 'noto-bold', label: 'Noto Sans Bold', family: 'Noto Sans', bold: true, file: 'NotoSans-Bold.ttf', css: 'wgc-noto', cssPerAss: 0.6583 },
  { id: 'noto', label: 'Noto Sans', family: 'Noto Sans', bold: false, file: 'NotoSans-Regular.ttf', css: 'wgc-noto', cssPerAss: 0.6583 },
  { id: 'anton', label: 'Anton (meme style)', family: 'Anton', bold: false, file: 'Anton-Regular.ttf', css: 'wgc-anton', cssPerAss: 0.5769 },
];

export function font(id: FontId): BundledFont {
  return FONTS.find((f) => f.id === id) ?? FONTS[0];
}
