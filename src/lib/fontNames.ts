interface NameRecord {
  id: number;
  value: string;
}

type Tag = (off: number) => string;

function sfnt(bytes: Uint8Array): { view: DataView; tag: Tag; offsets: number[] } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag: Tag = (off) => String.fromCharCode(...bytes.subarray(off, off + 4));
  const offsets = tag(0) === 'ttcf'
    ? Array.from({ length: view.getUint32(8) }, (_, i) => view.getUint32(12 + 4 * i))
    : [0];
  return { view, tag, offsets };
}

function tableOffset(view: DataView, tag: Tag, base: number, name: string): number {
  const numTables = view.getUint16(base + 4);
  for (let i = 0; i < numTables; i++) {
    const rec = base + 12 + 16 * i;
    if (tag(rec) === name) return view.getUint32(rec + 8);
  }
  return -1;
}

function nameRecords(view: DataView, bytes: Uint8Array, tag: Tag, base: number): NameRecord[] {
  const nameOff = tableOffset(view, tag, base, 'name');
  if (nameOff < 0) return [];
  const count = view.getUint16(nameOff + 2);
  const strings = nameOff + view.getUint16(nameOff + 4);
  const out: NameRecord[] = [];
  for (let i = 0; i < count; i++) {
    const r = nameOff + 6 + 12 * i;
    const platform = view.getUint16(r);
    const id = view.getUint16(r + 6);
    const len = view.getUint16(r + 8);
    const start = strings + view.getUint16(r + 10);
    const raw = bytes.subarray(start, start + len);
    let value = '';
    if (platform === 3 || platform === 0) {
      for (let j = 0; j + 1 < raw.length; j += 2) value += String.fromCharCode((raw[j] << 8) | raw[j + 1]);
    } else if (platform === 1) {
      value = String.fromCharCode(...raw);
    } else continue;
    if (value.trim()) out.push({ id, value });
  }
  return out;
}

/**
 * Names a font file can be matched by in libass: family (1), full name (4),
 * PostScript name (6) and typographic family (16), from the sfnt 'name' table.
 * Handles TTF, OTF and TTC collections.
 */
export function fontNames(bytes: Uint8Array): string[] {
  const { view, tag, offsets } = sfnt(bytes);
  const names = new Set<string>();
  for (const base of offsets) {
    try {
      nameRecords(view, bytes, tag, base).filter((r) => [1, 4, 6, 16].includes(r.id)).forEach((r) => names.add(r.value));
    } catch {
      // Malformed font: skip it rather than fail the whole load.
    }
  }
  return [...names];
}

export interface FontInfo {
  /** Legacy family name (nameID 1), what an ASS Fontname should say. */
  family: string;
  /** Full name, for display. */
  fullName: string;
  bold: boolean;
  /** unitsPerEm / (usWinAscent + usWinDescent); see FontChoice.cssPerAss. */
  cssPerAss: number;
}

/** Family, weight and size metrics of a font file (the first face of a collection). */
export function fontInfo(bytes: Uint8Array): FontInfo | null {
  try {
    const { view, tag, offsets } = sfnt(bytes);
    const base = offsets[0];
    const names = nameRecords(view, bytes, tag, base);
    const family = names.find((r) => r.id === 1)?.value ?? names.find((r) => r.id === 16)?.value;
    if (!family) return null;
    const head = tableOffset(view, tag, base, 'head');
    const os2 = tableOffset(view, tag, base, 'OS/2');
    const upm = head >= 0 ? view.getUint16(head + 18) : 1000;
    let bold = head >= 0 && (view.getUint16(head + 44) & 1) === 1;
    let cssPerAss = 0.8;
    if (os2 >= 0) {
      bold ||= view.getUint16(os2 + 4) >= 600 || (view.getUint16(os2 + 62) & 0x20) !== 0;
      const winAscent = view.getUint16(os2 + 74);
      const winDescent = view.getUint16(os2 + 76);
      if (winAscent + winDescent > 0) cssPerAss = upm / (winAscent + winDescent);
    }
    const fullName = names.find((r) => r.id === 4)?.value ?? family;
    return { family, fullName, bold, cssPerAss };
  } catch {
    return null;
  }
}

/**
 * libass inside ffmpeg.wasm has no system fonts and renders nothing for a font it
 * can't find. Point every style and \fn override that names an unavailable font at
 * the fallback.
 */
export function remapMissingFonts(ass: string, available: string[], fallback: string): string {
  const have = new Set(available.map((n) => n.toLowerCase()));
  const ok = (name: string) => have.has(name.replace(/^@/, '').trim().toLowerCase());
  let section = '';
  let fontField = 1;
  return ass
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (t.startsWith('[')) {
        section = t.toLowerCase();
        return line;
      }
      if (section === '[v4+ styles]' || section === '[v4 styles]') {
        if (/^format:/i.test(t)) {
          fontField = t.slice(7).split(',').map((s) => s.trim().toLowerCase()).indexOf('fontname');
          return line;
        }
        if (/^style:/i.test(t) && fontField >= 0) {
          const parts = line.slice(line.indexOf(':') + 1).split(',');
          if (!ok(parts[fontField] ?? '')) parts[fontField] = fallback;
          return `Style:${parts.join(',')}`;
        }
      }
      if (section === '[events]' && /^dialogue:/i.test(t)) {
        return line.replace(/\\fn([^\\}]*)/g, (m, name: string) => (ok(name) ? m : `\\fn${fallback}`));
      }
      return line;
    })
    .join('\n');
}
