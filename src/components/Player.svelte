<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { TextOverlay } from '../lib/ass';
  import { font } from '../lib/fonts';
  import { PreviewSession, type Frame, type SoundSource, type VideoSource } from '../lib/preview/session';
  import { activeAt, cueText, ORIGINAL_PREVIEW_STYLE, overlapping, type SubtitleStyle } from '../lib/subtitles';
  import { formatTime } from '../lib/time';
  import { app, controls, editHandlers, frameDuration, playback, renderPreview } from '../state.svelte';
  import PresetSelect from './PresetSelect.svelte';

  let canvas: HTMLCanvasElement | undefined = $state();
  let audio: HTMLAudioElement | undefined = $state();
  let stage: HTMLDivElement | undefined = $state();
  let stageHeight = $state(0);
  /** What is being dragged: a caption (by id) or the subtitle block. */
  let drag: { id: string | null; dx: number; dy: number } | null = null;

  const dar = $derived(app.info?.dar ?? 16 / 9);
  const duration = $derived(app.info?.duration ?? 0);

  let session: PreviewSession | null = $state(null);
  let videoSource: VideoSource | null = $state(null);
  let soundSource: SoundSource = $state('none');
  let soundState = $state('');
  /** While dragging the timeline, frames are keyframes; the playhead follows the mouse. */
  let scrubbing = false;

  const included = $derived(app.subMode === 'off' ? [] : app.cues.filter((c) => !app.disabledCues.includes(c.line)));
  const subtitleNow = $derived(activeAt(included, app.current));
  // While the subtitle style is being edited, show a dimmed sample when no line is on
  // screen, so it can still be seen and dragged.
  const subtitleSample = $derived(
    app.subMode === 'custom' && app.editing === 'subtitles' && subtitleNow.length === 0
      ? (overlapping(included, app.start, app.end)[0] ?? included[0])
      : undefined,
  );
  const subtitleLines = $derived(
    (subtitleNow.length ? subtitleNow : subtitleSample ? [subtitleSample] : []).map((c) => cueText(c, app.cueOverrides)),
  );
  const subtitleLook = $derived<SubtitleStyle>(app.subMode === 'custom' ? app.settings.subtitleStyle : ORIGINAL_PREVIEW_STYLE);

  function onFrame(f: Frame) {
    if (!scrubbing) app.current = f.ts;
  }

  // One preview session per opened file.
  $effect(() => {
    const file = app.file;
    const input = app.input;
    const info = app.info;
    const el = audio;
    if (!file || !input || !info || info.unsupported || !el) return;
    let cancelled = false;
    let opened: PreviewSession | null = null;
    untrack(() => {
      void PreviewSession.open(file, input, $state.snapshot(info) as typeof info, el, onFrame).then((s) => {
        if (cancelled) return s.dispose();
        opened = s;
        sizeCanvas();
        if (canvas) s.attach(canvas);
        session = s;
      });
    });
    return () => {
      cancelled = true;
      opened?.dispose();
      session = null;
      videoSource = null;
    };
  });

  // (Re)select tracks when the session opens or the user picks different ones.
  $effect(() => {
    const s = session;
    const v = app.info?.videoIndex;
    const a = app.audioTrack;
    if (!s || v === undefined) return;
    untrack(() => {
      stop();
      void s.selectTracks(v, a).then(() => {
        if (s !== session) return;
        videoSource = s.videoSource;
        soundSource = s.soundSource;
        s.show(app.current);
      });
    });
  });

  $effect(() => {
    if (audio) {
      audio.volume = playback.volume;
      audio.muted = playback.muted;
    }
  });
  $effect(() => session?.setRate(playback.rate));

  /**
   * Match the canvas's pixel size to its size on screen (times the device pixel ratio),
   * so frames are drawn sharp rather than scaled up from the default 300×150.
   */
  function sizeCanvas() {
    if (!stage || !canvas || !stage.clientWidth) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.min(3840, Math.round(stage.clientWidth * dpr));
    const height = Math.round(width / dar);
    if (canvas.width !== width || canvas.height !== height) {
      // Setting the size clears the canvas; keep the picture (scaled) until the frame is
      // redrawn sharp at the new size.
      let copy: OffscreenCanvas | null = null;
      if (canvas.width && canvas.height) {
        copy = new OffscreenCanvas(canvas.width, canvas.height);
        copy.getContext('2d')?.drawImage(canvas, 0, 0);
      }
      canvas.width = width;
      canvas.height = height;
      if (copy) canvas.getContext('2d')?.drawImage(copy, 0, 0, width, height);
    }
    session?.resize(width, height);
  }

  onMount(() => {
    let settle: ReturnType<typeof setTimeout> | undefined;
    controls.seek = (t) => {
      const time = Math.max(0, Math.min(duration, t));
      clearTimeout(settle);
      scrubbing = false;
      app.current = time;
      if (playback.playing) void session?.play(time, onTick, lastFrameLimit());
      else session?.show(time);
    };
    controls.scrub = (t) => {
      const time = Math.max(0, Math.min(duration, t));
      if (playback.playing) stop();
      scrubbing = true;
      app.current = time;
      session?.show(time, true);
      // Holding still mid-drag shows the exact frame, not just the nearest keyframe.
      clearTimeout(settle);
      settle = setTimeout(() => scrubbing && session?.show(time), 200);
    };
    controls.step = (n) => {
      if (playback.playing) stop();
      scrubbing = false;
      session?.step(n);
    };
    controls.toggle = () => (playback.playing ? stop() : start());
    const observer = new ResizeObserver(() => sizeCanvas());
    if (stage) observer.observe(stage);
    return () => {
      observer.disconnect();
      stop();
    };
  });

  /**
   * Play from the playhead to the clip end. At the end, loop back to the clip start or
   * stop, depending on "Loop selection". From at or past the end, replay the clip.
   */
  async function start() {
    if (!session) return;
    const from = app.current >= app.end - frameDuration() / 2 ? app.start : app.current;
    scrubbing = false;
    playback.playing = true;
    if (soundSource !== 'none') soundState = 'loading';
    try {
      await session.play(from, onTick, lastFrameLimit());
      soundState = '';
    } catch (e) {
      soundState = `Couldn't play the sound: ${e instanceof Error ? e.message : e}`;
    }
  }

  function onTick(t: number) {
    if (!playback.playing) return;
    // With video, frames set the playhead; with stills only, the clock does.
    if (videoSource === 'stills') app.current = t;
    if (t >= app.end - 1e-3) reachedEnd();
  }

  /**
   * Playback draws only frames starting before this: half a frame short of the clip end,
   * the same cut the encoder makes (see seekPoint), so it shows exactly the GIF's frames.
   */
  function lastFrameLimit(): number {
    return app.end - frameDuration() / 2;
  }

  /** Playback hit the clip end (or the end of the video). */
  function reachedEnd() {
    if (playback.loop) void session?.play(app.start, onTick, lastFrameLimit());
    else {
      stop();
      session?.show(Math.max(app.start, app.end - frameDuration()));
    }
  }

  function stop() {
    session?.stop();
    playback.playing = false;
  }

  function overlayStyle(o: SubtitleStyle): string {
    const f = font(o.font);
    const px = (o.size / 100) * stageHeight;
    return [
      `left:${o.x * 100}%`,
      `top:${o.y * 100}%`,
      `font-family:${f.css}`,
      `font-weight:${f.bold ? 700 : 400}`,
      `font-size:${px * f.cssPerAss}px`,
      `line-height:${px}px`,
      `color:${o.color}`,
      `-webkit-text-stroke:${(2 * o.outline * stageHeight) / 100}px ${o.outlineColor}`,
    ].join(';');
  }

  function visible(o: TextOverlay): boolean {
    return (app.current >= o.start && app.current < o.end) || app.editing === o.id;
  }

  function pointerDown(e: PointerEvent, id: string | null, o: { x: number; y: number }) {
    if (!stage) return;
    // Focusing the text starts editing it (see editHandlers).
    (e.currentTarget as HTMLElement).focus();
    const r = stage.getBoundingClientRect();
    drag = { id, dx: e.clientX - (r.left + o.x * r.width), dy: e.clientY - (r.top + o.y * r.height) };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function pointerMove(e: PointerEvent) {
    if (!drag || !stage) return;
    const o = drag.id === null ? app.settings.subtitleStyle : app.overlays.find((x) => x.id === drag!.id);
    if (!o) return;
    const r = stage.getBoundingClientRect();
    o.x = Math.min(1, Math.max(0, (e.clientX - r.left - drag.dx) / r.width));
    o.y = Math.min(1, Math.max(0, (e.clientY - r.top - drag.dy) / r.height));
  }

  const VIDEO_SOURCE: Record<VideoSource, string> = {
    browser: 'decoded by the browser',
    software: 'decoded in software (FFmpeg)',
    stills: 'ffmpeg stills (this format can only be previewed frame by frame)',
  };
  const SOUND_SOURCE: Record<SoundSource, string> = {
    browser: 'decoded by the browser',
    software: 'decoded in software (FFmpeg)',
    ffmpeg: 'decoded by ffmpeg',
    none: '',
  };
</script>

<div class="card player">
  <div class="frame" bind:this={stage} bind:clientHeight={stageHeight} style:aspect-ratio={dar} style:--dar={dar}>
    <canvas bind:this={canvas} onclick={() => controls.toggle()}></canvas>
    <div class="layer">
      {#each app.overlays as o (o.id)}
        {#if visible(o)}
          <div
            class="text"
            class:editing={app.editing === o.id}
            class:inactive={!(app.current >= o.start && app.current < o.end)}
            style={overlayStyle(o)}
            role="button"
            tabindex="-1"
            data-edit={o.id}
            {...editHandlers(o.id)}
            onpointerdown={(e) => pointerDown(e, o.id, o)}
            onpointermove={pointerMove}
            onpointerup={() => (drag = null)}
          >{o.text}</div>
        {/if}
      {/each}
      {#if subtitleLines.length}
        <div
          class="text subtitle"
          class:draggable={app.subMode === 'custom'}
          class:inactive={subtitleNow.length === 0}
          class:approx={app.subMode === 'original'}
          style={overlayStyle(subtitleLook)}
          role="button"
          tabindex="-1"
          data-edit="subtitles"
          {...editHandlers('subtitles')}
          title={app.subMode === 'custom' ? 'Drag to move the subtitles' : 'Approximate preview of the original styling'}
          onpointerdown={(e) => app.subMode === 'custom' && pointerDown(e, null, app.settings.subtitleStyle)}
          onpointermove={pointerMove}
          onpointerup={() => (drag = null)}
        >{subtitleLines.join('\n')}</div>
      {/if}
    </div>
  </div>
  <audio bind:this={audio} preload="auto" hidden></audio>

  <div class="row bar">
    <button onclick={() => controls.toggle()} disabled={!session} title="Play/pause (Space)">
      {playback.playing ? 'Pause' : 'Play'}
    </button>
    <label class="row opt"><input type="checkbox" bind:checked={playback.loop} /> Loop selection</label>
    <span class="mono time">{formatTime(app.current)} / {formatTime(duration)}</span>
    <button onclick={renderPreview} disabled={!!app.busy} title="Render this frame with ffmpeg, including burned-in text">
      Preview exact frame
    </button>
  </div>
  <div class="row bar sound">
    <span class="row opt">
      Speed
      <PresetSelect
        label="Playback speed"
        bind:value={playback.rate}
        min={0.25}
        max={4}
        suffix="×"
        presets={[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].map((v) => ({ value: v, label: `${v}×` }))}
      />
    </span>
    {#if soundSource === 'none'}
      <span class="muted">{app.info?.audio.length ? 'Sound off' : 'This video has no audio'}</span>
    {:else}
      <button class="small" onclick={() => (playback.muted = !playback.muted)} title="Mute (M)">
        {playback.muted ? 'Unmute' : 'Mute'}
      </button>
      <input type="range" min="0" max="1" step="0.05" bind:value={playback.volume} aria-label="Volume" />
      {#if soundState === 'loading'}
        <span class="muted status">Decoding sound…</span>
      {:else if soundState}
        <span class="warn status">{soundState}</span>
      {/if}
    {/if}
  </div>
  {#if videoSource}
    <p class="muted note decoding">
      Video {VIDEO_SOURCE[videoSource]}{#if soundSource !== 'none'}; sound {SOUND_SOURCE[soundSource]}{/if}.
    </p>
  {/if}
  {#if app.preview}
    <div class="exact">
      <div class="row">
        <strong>ffmpeg render at {formatTime(app.preview.time)}</strong>
        <span class="muted">this is exactly what the GIF frame will look like before dithering</span>
        <button class="small" onclick={() => (app.preview = null)}>Close</button>
      </div>
      <img src={app.preview.url} alt="ffmpeg-rendered preview frame" />
    </div>
  {/if}
</div>

<style>
  .player {
    display: grid;
    gap: 0.6rem;
  }
  .frame {
    position: relative;
    width: min(100%, calc(62vh * var(--dar)));
    margin: 0 auto;
    background: #000;
    border-radius: 4px;
    overflow: hidden;
  }
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
  }
  .layer {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  .text {
    position: absolute;
    transform: translate(-50%, -50%);
    white-space: pre;
    text-align: center;
    paint-order: stroke fill;
    pointer-events: auto;
    cursor: move;
    user-select: none;
    touch-action: none;
  }
  .text.editing {
    outline: 1px dashed rgba(255, 255, 255, 0.8);
    outline-offset: 4px;
  }
  .text.inactive {
    opacity: 0.45;
  }
  /* Subtitles are anchored at their bottom centre, like the ASS they become. */
  .text.subtitle {
    transform: translate(-50%, -100%);
    cursor: default;
  }
  .text.subtitle.draggable {
    cursor: move;
  }
  .text.subtitle.approx {
    pointer-events: none;
  }
  .bar .time {
    margin-left: auto;
    font-size: 0.9rem;
  }
  .opt {
    gap: 0.3rem;
    font-size: 0.9rem;
  }
  .sound {
    font-size: 0.85rem;
  }
  .sound input[type='range'] {
    width: 90px;
  }
  .status {
    font-size: 0.82rem;
  }
  .warn {
    color: var(--warn);
  }
  .note {
    margin: 0;
    font-size: 0.82rem;
  }
  .exact {
    display: grid;
    gap: 0.4rem;
    border-top: 1px solid var(--border);
    padding-top: 0.6rem;
  }
  .exact img {
    max-width: 100%;
    margin: 0 auto;
    display: block;
  }
  .exact .muted {
    font-size: 0.85rem;
  }
</style>
