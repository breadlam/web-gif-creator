/**
 * Names a font file can be matched by in libass: family (1), full name (4),
 * PostScript name (6) and typographic family (16), from the sfnt 'name' table.
 * Handles TTF, OTF and TTC collections.
 */
export function fontNames(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (off: number) => String.fromCharCode(...bytes.subarray(off, off + 4));
  const offsets = tag(0) === 'ttcf'
    ? Array.from({ length: view.getUint32(8) }, (_, i) => view.getUint32(12 + 4 * i))
    : [0];
  const names = new Set<string>();
  for (const base of offsets) {
    try {
      readNames(view, bytes, base, tag).forEach((n) => names.add(n));
    } catch {
      // Malformed font: skip it rather than fail the whole load.
    }
  }
  return [...names];
}

function readNames(view: DataView, bytes: Uint8Array, base: number, tag: (o: number) => string): string[] {
  const numTables = view.getUint16(base + 4);
  let nameOff = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = base + 12 + 16 * i;
    if (tag(rec) === 'name') nameOff = view.getUint32(rec + 8);
  }
  if (nameOff < 0) return [];
  const count = view.getUint16(nameOff + 2);
  const strings = nameOff + view.getUint16(nameOff + 4);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const r = nameOff + 6 + 12 * i;
    const platform = view.getUint16(r);
    const nameId = view.getUint16(r + 6);
    if (![1, 4, 6, 16].includes(nameId)) continue;
    const len = view.getUint16(r + 8);
    const start = strings + view.getUint16(r + 10);
    const raw = bytes.subarray(start, start + len);
    if (platform === 3 || platform === 0) {
      let s = '';
      for (let j = 0; j + 1 < raw.length; j += 2) s += String.fromCharCode((raw[j] << 8) | raw[j + 1]);
      out.push(s);
    } else if (platform === 1) {
      out.push(String.fromCharCode(...raw));
    }
  }
  return out.filter((s) => s.trim());
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
