export interface SubtitleTrack {
  /** Absolute stream index in the input. */
  index: number;
  codec: string;
  language: string;
  title: string;
  /** Text-based (can be converted to ASS); bitmap tracks (PGS, VobSub) are not supported yet. */
  text: boolean;
  default: boolean;
  forced: boolean;
}

export interface VideoTrack {
  index: number;
  codec: string;
  width: number;
  height: number;
  /** Display aspect ratio (accounts for anamorphic pixels). */
  dar: number;
  fps: number;
  language: string;
  title: string;
  default: boolean;
}

export interface AudioTrack {
  index: number;
  codec: string;
  language: string;
  title: string;
  channels: number;
  default: boolean;
}

export interface FontAttachment {
  index: number;
  filename: string;
}

/** The fields of MediaInfo that describe the video track being worked on. */
export interface VideoFields {
  /** Stream index of the selected video track. */
  videoIndex: number;
  codec: string;
  width: number;
  height: number;
  /** Display aspect ratio (accounts for anamorphic pixels). */
  dar: number;
  fps: number;
  /** Set when the in-browser ffmpeg build cannot decode the video. */
  unsupported: string | null;
}

export interface MediaInfo extends VideoFields {
  duration: number;
  videos: VideoTrack[];
  subtitles: SubtitleTrack[];
  audio: AudioTrack[];
  fonts: FontAttachment[];
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
  channels?: number;
  duration?: string;
  disposition?: { attached_pic?: number; default?: number; forced?: number };
  tags?: Record<string, string>;
}

export interface ProbeJson {
  streams?: ProbeStream[];
  format?: { duration?: string };
}

export function parseProbe(json: ProbeJson): MediaInfo {
  const streams = json.streams ?? [];
  const tag = (s: ProbeStream, k: string) => s.tags?.[k] ?? s.tags?.[k.toUpperCase()] ?? '';
  const videos: VideoTrack[] = streams
    .filter((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)
    .map((s) => {
      const width = s.width ?? 0;
      const height = s.height ?? 0;
      let dar = rate(s.display_aspect_ratio?.replace(':', '/'));
      if (!dar) dar = (width / (height || 1)) * (rate(s.sample_aspect_ratio?.replace(':', '/')) || 1);
      const avg = rate(s.avg_frame_rate);
      return {
        index: s.index,
        codec: s.codec_name ?? 'unknown',
        width,
        height,
        dar,
        fps: avg > 0 && avg < 1000 ? avg : rate(s.r_frame_rate),
        language: tag(s, 'language'),
        title: tag(s, 'title'),
        default: s.disposition?.default === 1,
      };
    });
  if (videos.length === 0) throw new Error('No video stream found in this file.');
  const video = videos.find((v) => v.default) ?? videos[0];
  const videoStream = streams.find((s) => s.index === video.index);
  const duration = parseFloat(json.format?.duration ?? videoStream?.duration ?? '0');
  const subtitles = streams
    .filter((s) => s.codec_type === 'subtitle')
    .map((s) => ({
      index: s.index,
      codec: s.codec_name ?? 'unknown',
      language: tag(s, 'language'),
      title: tag(s, 'title'),
      text: TEXT_SUBTITLE_CODECS.has(s.codec_name ?? ''),
      default: s.disposition?.default === 1,
      forced: s.disposition?.forced === 1,
    }));
  const audio = streams
    .filter((s) => s.codec_type === 'audio')
    .map((s) => ({
      index: s.index,
      codec: s.codec_name ?? 'unknown',
      language: tag(s, 'language'),
      title: tag(s, 'title'),
      channels: s.channels ?? 0,
      default: s.disposition?.default === 1,
    }));
  const fonts = streams
    .filter((s) => s.codec_type === 'attachment')
    .filter((s) => /font|truetype|opentype/i.test(tag(s, 'mimetype')) || /\.(ttf|otf|ttc)$/i.test(tag(s, 'filename')))
    .map((s) => ({ index: s.index, filename: tag(s, 'filename') }));

  return { duration, videos, subtitles, audio, fonts, ...videoFields(video) };
}

export function videoFields(v: VideoTrack): VideoFields {
  return {
    videoIndex: v.index, codec: v.codec, width: v.width, height: v.height, dar: v.dar, fps: v.fps,
    unsupported: UNSUPPORTED_CODECS[v.codec] ?? null,
  };
}

export function describeVideo(v: VideoTrack): string {
  const bits = [v.language && v.language !== 'und' ? v.language : '', v.title, v.codec.toUpperCase(),
    `${v.width}×${v.height}`, v.fps ? `${Math.round(v.fps * 100) / 100} fps` : ''].filter(Boolean);
  return bits.join(' · ');
}

/** Output width for a target height, matching scale=w='trunc(H*dar/2)*2'. */
export function outputWidth(info: Pick<MediaInfo, 'dar'>, height: number): number {
  return Math.trunc((height * info.dar) / 2) * 2;
}

/** The audio track to start with: the one flagged default, else the first. */
export function defaultAudioTrack(tracks: AudioTrack[]): number | null {
  return (tracks.find((t) => t.default) ?? tracks[0])?.index ?? null;
}

export function describeAudio(t: AudioTrack): string {
  const ch = t.channels === 1 ? 'mono' : t.channels === 2 ? 'stereo' : t.channels ? `${t.channels}ch` : '';
  const bits = [t.language && t.language !== 'und' ? t.language : '', t.title, t.codec.toUpperCase(), ch].filter(Boolean);
  return bits.join(' · ');
}

export function describeTrack(t: SubtitleTrack): string {
  const bits = [t.language && t.language !== 'und' ? t.language : '', t.title, t.codec].filter(Boolean);
  return bits.join(' · ');
}
