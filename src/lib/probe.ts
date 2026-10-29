export interface SubtitleTrack {
  /** Absolute stream index in the input. */
  index: number;
  codec: string;
  language: string;
  title: string;
  /** Text-based (can be converted to ASS); bitmap tracks (PGS, VobSub) are not supported yet. */
  text: boolean;
}

export interface FontAttachment {
  index: number;
  filename: string;
}

export interface MediaInfo {
  duration: number;
  codec: string;
  width: number;
  height: number;
  /** Display aspect ratio (accounts for anamorphic pixels). */
  dar: number;
  fps: number;
  subtitles: SubtitleTrack[];
  fonts: FontAttachment[];
  /** Set when the in-browser ffmpeg build cannot decode the video. */
  unsupported: string | null;
}

const TEXT_SUBTITLE_CODECS = new Set([
  'ass', 'ssa', 'subrip', 'srt', 'webvtt', 'mov_text', 'text', 'microdvd', 'subviewer',
  'subviewer1', 'mpl2', 'realtext', 'jacosub', 'stl', 'sami', 'vplayer', 'pjs',
]);

/** Codecs the ffmpeg.wasm 0.12 core (FFmpeg 5.1.4, no external decoders) can't decode. */
const UNSUPPORTED_CODECS: Record<string, string> = {
  av1: 'AV1 video can\'t be decoded by the in-browser ffmpeg build (it has no dav1d). Use an H.264, HEVC or VP9 copy of this video.',
};

function rate(r: string | undefined): number {
  if (!r) return 0;
  const [n, d] = r.split('/').map(Number);
  return d ? n / d : n || 0;
}

// ffprobe's JSON is loosely typed; only the fields used here are declared.
interface ProbeStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  sample_aspect_ratio?: string;
  display_aspect_ratio?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  disposition?: { attached_pic?: number };
  tags?: Record<string, string>;
}

export interface ProbeJson {
  streams?: ProbeStream[];
  format?: { duration?: string };
}

export function parseProbe(json: ProbeJson): MediaInfo {
  const streams = json.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!video) throw new Error('No video stream found in this file.');
  const width = video.width ?? 0;
  const height = video.height ?? 0;
  let dar = rate(video.display_aspect_ratio?.replace(':', '/'));
  if (!dar) {
    const sar = rate(video.sample_aspect_ratio?.replace(':', '/')) || 1;
    dar = (width / height) * sar;
  }
  const avg = rate(video.avg_frame_rate);
  const fps = avg > 0 && avg < 1000 ? avg : rate(video.r_frame_rate);
  const duration = parseFloat(json.format?.duration ?? video.duration ?? '0');
  const codec = video.codec_name ?? 'unknown';

  const tag = (s: ProbeStream, k: string) => s.tags?.[k] ?? s.tags?.[k.toUpperCase()] ?? '';
  const subtitles = streams
    .filter((s) => s.codec_type === 'subtitle')
    .map((s) => ({
      index: s.index,
      codec: s.codec_name ?? 'unknown',
      language: tag(s, 'language'),
      title: tag(s, 'title'),
      text: TEXT_SUBTITLE_CODECS.has(s.codec_name ?? ''),
    }));
  const fonts = streams
    .filter((s) => s.codec_type === 'attachment')
    .filter((s) => /font|truetype|opentype/i.test(tag(s, 'mimetype')) || /\.(ttf|otf|ttc)$/i.test(tag(s, 'filename')))
    .map((s) => ({ index: s.index, filename: tag(s, 'filename') }));

  return {
    duration, codec, width, height, dar, fps, subtitles, fonts,
    unsupported: UNSUPPORTED_CODECS[codec] ?? null,
  };
}

/** Output width for a target height, matching scale=w='trunc(H*dar/2)*2'. */
export function outputWidth(info: Pick<MediaInfo, 'dar'>, height: number): number {
  return Math.trunc((height * info.dar) / 2) * 2;
}

export function describeTrack(t: SubtitleTrack): string {
  const bits = [t.language && t.language !== 'und' ? t.language : '', t.title, t.codec].filter(Boolean);
  return `#${t.index} ${bits.join(' · ')}`;
}
