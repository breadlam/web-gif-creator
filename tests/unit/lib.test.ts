import { describe, expect, it } from 'vitest';
import { assColor, assTime, buildOverlayAss, disableCues, escapeAssText, parseAssCues, plainText, type TextOverlay } from '../../src/lib/ass';
import { analysisArgs, dumpFontArgs, encodeArgs, extractSubtitlesArgs, scaleFilter, textFilters } from '../../src/lib/commands';
import { fontNames, remapMissingFonts } from '../../src/lib/fontNames';
import { featureValue, parseFrameMetadata, parseFrameProgress, parseTimeProgress } from '../../src/lib/metadata';
import { outputWidth, parseProbe, type ProbeJson } from '../../src/lib/probe';
import { coefsAt, estimateK, frameCount, gifBytes, MODEL, planFps, snapFps } from '../../src/lib/sizeModel';
import { compactTime, formatTime, parseTime } from '../../src/lib/time';
import { activeAt, applyOverrides, bestTrack, buildSubtitleAss, DEFAULT_SUBTITLE_STYLE, nearby, overlapping, searchCues } from '../../src/lib/subtitles';

describe('time', () => {
  it('formats and parses', () => {
    expect(formatTime(83.25)).toBe('1:23.250');
    expect(formatTime(3723.5)).toBe('1:02:03.500');
    expect(parseTime('1:23.25')).toBeCloseTo(83.25);
    expect(parseTime('0:01:02.5')).toBeCloseTo(62.5);
    expect(parseTime('12')).toBe(12);
    expect(parseTime('1:2:3:4')).toBeNull();
    expect(parseTime('abc')).toBeNull();
    expect(compactTime(83.25)).toBe('1m23.25s');
    expect(compactTime(5)).toBe('5s');
  });
});

describe('size model', () => {
  it('interpolates coefficients between calibrated heights', () => {
    const hs = Object.keys(MODEL.models.sierra2_4a.coefsByHeight).map(Number).sort((a, b) => a - b);
    const lo = MODEL.models.sierra2_4a.coefsByHeight[hs[0]][0];
    const hi = MODEL.models.sierra2_4a.coefsByHeight[hs[1]][0];
    expect(coefsAt('sierra2_4a', (hs[0] + hs[1]) / 2)[0]).toBeCloseTo((lo + hi) / 2);
    expect(coefsAt('sierra2_4a', 100)[0]).toBe(lo);
  });

  it('snaps to uniform centisecond delays', () => {
    expect(snapFps(23.976, true)).toEqual({ fps: 20, delayCs: 5 });
    expect(snapFps(60, true)).toEqual({ fps: 50, delayCs: 2 });
    expect(snapFps(12.4, true).delayCs).toBe(9);
    expect(snapFps(23.976, false)).toEqual({ fps: 23.97, delayCs: null });
  });

  it('plans the highest frame rate that fits the budget', () => {
    const k = { expected: 0.3, safe: 0.35 };
    const p = planFps({ budget: 20e6, duration: 10, width: 960, height: 540, k, sourceFps: 60, uniform: false });
    expect(p.limitedBy).toBe('budget');
    expect(p.safeBytes).toBeLessThanOrEqual(20e6);
    // One more frame would not fit.
    expect(gifBytes(p.frames + 1, 960, 540, k.safe)).toBeGreaterThan(20e6 - 960 * 540 * k.safe);
    expect(p.fps).toBeGreaterThan(10);
  });

  it('caps at the source frame rate', () => {
    const p = planFps({ budget: 20e6, duration: 2, width: 960, height: 540, k: { expected: 0.2, safe: 0.25 }, sourceFps: 23.976, uniform: true });
    expect(p.limitedBy).toBe('source');
    expect(p.fps).toBe(20);
  });

  it('counts frames like the fps filter', () => {
    expect(frameCount(10, 15)).toBe(150);
    expect(frameCount(0.01, 15)).toBe(1);
  });

  it('estimates k from features', () => {
    const m = MODEL.models.sierra2_4a;
    const values = Object.fromEntries(m.features.map((f) => [`${f.kind}${f.threshold}`, 0.5]));
    const k = estimateK('sierra2_4a', 540, values);
    expect(k.safe).toBeCloseTo(k.expected * m.margin);
    expect(k.expected).toBeGreaterThan(0.1);
  });
});

describe('metadata parsing', () => {
  const bbox = [
    'frame:0    pts:1      pts_time:0.066667',
    'lavfi.bbox.x1=0', 'lavfi.bbox.x2=959', 'lavfi.bbox.y1=0', 'lavfi.bbox.y2=539',
    'lavfi.bbox.w=960', 'lavfi.bbox.h=540',
    'frame:1    pts:2      pts_time:0.133333',
    'frame:2    pts:3      pts_time:0.2',
    'lavfi.bbox.w=480', 'lavfi.bbox.h=270',
  ].join('\n');

  it('keeps frames without a value as null', () => {
    expect(parseFrameMetadata(bbox, 'lavfi.bbox.w')).toEqual([960, null, 480]);
  });

  it('computes the feature with the first frame counted as changed', () => {
    // frames: 1 (implicit first), 1, 0, 0.25
    expect(featureValue({ kind: 'bbox', threshold: 3 }, bbox, 960, 540, 4)).toBeCloseTo((1 + 1 + 0 + 0.25) / 4);
  });

  it('counts frames missing from the metadata (no changed pixels) as unchanged', () => {
    // 6 GIF frames, only 3 differences printed
    expect(featureValue({ kind: 'bbox', threshold: 3 }, bbox, 960, 540, 6)).toBeCloseTo((1 + 1 + 0 + 0.25) / 6);
  });

  it('reads ffmpeg stats lines', () => {
    expect(parseFrameProgress('frame=  123 fps= 45 q=-0.0 size=N/A time=00:00:08.20')).toBe(123);
    expect(parseTimeProgress('size=N/A time=00:01:02.50 bitrate=N/A')).toBeCloseTo(62.5);
    expect(parseTimeProgress('time=-00:00:00.04')).toBeNull();
  });
});

describe('ASS', () => {
  const overlay: TextOverlay = {
    id: 'a', text: 'Hello {world}\nline 2', font: 'noto-bold', size: 10, color: '#ffcc00',
    outlineColor: '#000000', outline: 0.5, x: 0.5, y: 0.9, start: 61.5, end: 63,
  };

  it('converts colours and times', () => {
    expect(assColor('#ffcc00')).toBe('&H0000CCFF');
    expect(assTime(61.5)).toBe('0:01:01.50');
    expect(assTime(3723.456)).toBe('1:02:03.46');
  });

  it('escapes user text', () => {
    expect(escapeAssText('a{b}\nc\\N')).toBe('a｛b｝\\Nc\\​N');
  });

  it('builds a script positioned in output pixels', () => {
    const ass = buildOverlayAss([overlay], 960, 540);
    expect(ass).toContain('PlayResX: 960');
    expect(ass).toContain('Style: O0,Noto Sans,54,&H0000CCFF');
    expect(ass).toContain(',-1,0,0,0,'); // bold
    expect(ass).toContain('Dialogue: 0,0:01:01.50,0:01:03.00,O0,,0,0,0,,{\\pos(480,486)}Hello');
    expect(ass).toContain('\\Nline 2');
  });

  it('parses cues and disables chosen lines', () => {
    const src = [
      '[Script Info]', 'Title: x', '', '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,{\\i1}Hi, there\\Nfriend',
      'Comment: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,ignored',
      'Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,Bye',
    ].join('\n');
    const cues = parseAssCues(src);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({ line: 5, start: 1, end: 2.5, text: 'Hi, there\nfriend' });
    const out = disableCues(src, new Set([7]));
    expect(out.split('\n')[7]).toMatch(/^Comment: 0,0:00:05.00/);
    expect(out.split('\n')[5]).toMatch(/^Dialogue:/);
    expect(plainText('{\\an8}A\\hB')).toBe('A B');
  });
});

describe('probe', () => {
  const json: ProbeJson = {
    format: { duration: '1450.5' },
    streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264', width: 720, height: 480, sample_aspect_ratio: '32:27', display_aspect_ratio: '16:9', avg_frame_rate: '24000/1001' },
      { index: 1, codec_type: 'audio', codec_name: 'aac' },
      { index: 2, codec_type: 'subtitle', codec_name: 'ass', tags: { language: 'eng', title: 'Signs' } },
      { index: 3, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle' },
      { index: 4, codec_type: 'attachment', codec_name: 'ttf', tags: { filename: 'Font.TTF', mimetype: 'application/x-truetype-font' } },
      { index: 5, codec_type: 'attachment', tags: { filename: 'cover.jpg', mimetype: 'image/jpeg' } },
    ],
  };

  it('extracts what the app needs', () => {
    const info = parseProbe(json);
    expect(info.fps).toBeCloseTo(23.976, 3);
    expect(info.dar).toBeCloseTo(16 / 9);
    expect(outputWidth(info, 540)).toBe(960);
    expect(info.subtitles.map((s) => [s.index, s.text])).toEqual([[2, true], [3, false]]);
    expect(info.fonts).toEqual([{ index: 4, filename: 'Font.TTF' }]);
    expect(info.unsupported).toBeNull();
  });

  it('flags AV1', () => {
    const av1: ProbeJson = { ...json, streams: [{ ...json.streams![0], codec_name: 'av1' }] };
    expect(parseProbe(av1).unsupported).toMatch(/AV1/);
  });
});

describe('commands', () => {
  const clip = { input: '/input/input.mkv', start: 61.5, duration: 4, height: 540 };

  it('builds the encode graph used for calibration', () => {
    const args = encodeArgs(clip, 15, 'sierra2_4a', {}, '/work/out.gif');
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph).toBe(
      `[0:v]${scaleFilter(540)},fps=15,split=3[n][a][b];[a]palettegen=stats_mode=diff[p];` +
        '[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle[g]',
    );
    expect(args.slice(0, 10)).toEqual(['-hide_banner', '-loglevel', 'info', '-y', '-ss', '61.500', '-t', '4.000', '-i', '/input/input.mkv']);
    expect(args.slice(-5)).toEqual(['-map', '[g]', '-loop', '0', '/work/out.gif']);
  });

  it('shifts timestamps around subtitle burn-in', () => {
    expect(textFilters(61.5, { overlays: '/work/o.ass' })).toEqual([
      'setpts=PTS+61.501/TB', 'subtitles=filename=/work/o.ass:fontsdir=/fonts', 'setpts=PTS-STARTPTS',
    ]);
    // Burned in before fps, while the time base is still fine-grained.
    const args = encodeArgs({ input: 'in', start: 61.5, duration: 2, height: 540 }, 15, 'bayer', { subtitles: '/work/s.ass' }, 'o.gif');
    expect(args[args.indexOf('-filter_complex') + 1]).toMatch(/setsar=1,setpts=PTS\+61\.501\/TB,subtitles=[^,]+,setpts=PTS-STARTPTS,fps=15,split=3/);
    expect(textFilters(0, {})).toEqual([]);
  });

  it('splits the analysis pass per feature', () => {
    const args = analysisArgs(clip, 15, {}, [{ kind: 'bbox', threshold: 8 }, { kind: 'changed', threshold: 3 }]);
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph).toContain('tblend=all_mode=difference,split=2[f0][f1];');
    expect(graph).toContain('[f0]bbox=min_val=8,metadata=mode=print:file=/work/feature-bbox8.txt[o0]');
    expect(graph).toContain("[f1]lutyuv=y='if(gt(val,3),255,0)',signalstats,");
    expect(args.filter((a) => a === 'null')).toHaveLength(2);
    const single = analysisArgs(clip, 15, {}, [{ kind: 'bbox', threshold: 3 }]);
    expect(single[single.indexOf('-filter_complex') + 1]).toMatch(/difference\[f0\];\[f0\]bbox=min_val=3/);
  });

  it('dumps font attachments by stream index', () => {
    expect(dumpFontArgs('/input/a.mkv', [{ index: 4, filename: 'X.OTF' }])).toEqual([
      '-hide_banner', '-loglevel', 'info', '-y', '-dump_attachment:4', '/fonts/attachment-4.otf', '-i', '/input/a.mkv',
    ]);
  });
});

describe('font names', () => {
  it('reads family names from the bundled fonts', async () => {
    const { readFileSync } = await import('node:fs');
    const names = fontNames(new Uint8Array(readFileSync('public/fonts/NotoSans-Bold.ttf')));
    expect(names).toContain('Noto Sans');
    expect(names).toContain('Noto Sans Bold');
  });

  it('remaps styles and \\fn overrides that use unavailable fonts', () => {
    const ass = [
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour',
      'Style: Default,Arial,20,&H00FFFFFF',
      'Style: Sign,Embedded Font,20,&H00FFFFFF',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\fnComic Sans}a{\\fnembedded font}b',
    ].join('\n');
    const out = remapMissingFonts(ass, ['Embedded Font', 'Noto Sans'], 'Noto Sans').split('\n');
    expect(out[2]).toBe('Style: Default,Noto Sans,20,&H00FFFFFF');
    expect(out[3]).toBe('Style: Sign,Embedded Font,20,&H00FFFFFF');
    expect(out[6]).toContain('{\\fnNoto Sans}a{\\fnembedded font}b');
  });
});

describe('subtitles', () => {
  const cues = [
    { line: 10, start: 1, end: 2, text: 'one' },
    { line: 11, start: 2.5, end: 4, text: 'Two words' },
    { line: 12, start: 30, end: 31, text: 'far away' },
  ];
  const track = (index: number, title: string, language = 'eng', forced = false) =>
    ({ index, codec: 'ass', language, title, text: true, default: false, forced });

  it('finds overlapping, active, nearby and matching cues', () => {
    expect(overlapping(cues, 1.5, 3).map((c) => c.line)).toEqual([10, 11]);
    expect(activeAt(cues, 2.6).map((c) => c.line)).toEqual([11]);
    expect(nearby(cues, 0, 2).map((c) => c.line)).toEqual([10, 11]);
    expect(searchCues(cues, 'WORDS').map((c) => c.line)).toEqual([11]);
    expect(searchCues(cues, '  ')).toEqual([]);
  });

  it('prefers dialogue tracks over signs, then language, then line count', () => {
    const tracks = [track(3, 'English Lyrics/Signs'), track(4, 'English Subtitles'), track(5, 'Japanese', 'jpn')];
    expect(bestTrack(tracks, { 3: 40, 4: 308, 5: 400 }, 'en-US')).toBe(4);
    expect(bestTrack(tracks, { 3: 40, 4: 308, 5: 400 }, 'ja')).toBe(5);
    expect(bestTrack([track(3, 'Signs'), track(4, 'Full', 'eng', true)], { 3: 10, 4: 0 }, 'en')).toBe(3);
    expect(bestTrack(tracks, {}, 'en')).toBeNull();
  });

  it('replaces the text of edited lines only', () => {
    const ass = [
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\i1}Hi, there',
      'Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,Keep',
    ].join('\n');
    const out = applyOverrides(ass, { 2: 'Hello\nworld' }).split('\n');
    expect(out[2]).toBe('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hello\\Nworld');
    expect(out[3]).toContain(',,Keep');
  });

  it('builds bottom-centre subtitles positioned by margins', () => {
    const style = { ...DEFAULT_SUBTITLE_STYLE, x: 0.25, y: 0.9 };
    const ass = buildSubtitleAss(cues.slice(0, 2), { 11: 'changed' }, style, 960, 540);
    // centre at x=240: MarginL 0, MarginR 480; bottom at y=486: MarginV 54
    expect(ass).toMatch(/Style: Sub,Noto Sans,41,.*,2,0,480,54,1/);
    expect(ass).toContain('Dialogue: 0,0:00:01.00,0:00:02.00,Sub,,0,0,0,,one');
    expect(ass).toContain(',,changed');
  });
});

describe('subtitle extraction command', () => {
  it('converts every track in one pass', () => {
    expect(extractSubtitlesArgs('/input/a.mkv', [{ index: 3, codec: 'ass' }, { index: 4, codec: 'subrip' }]).slice(3)).toEqual([
      '-y', '-i', '/input/a.mkv',
      '-map', '0:3', '-c:s', 'copy', '/work/track-3.ass',
      '-map', '0:4', '-c:s', 'ass', '/work/track-4.ass',
    ]);
  });
});
