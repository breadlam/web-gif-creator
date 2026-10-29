<script lang="ts">
  import { onMount } from 'svelte';
  import type { TextOverlay } from '../lib/ass';
  import { font } from '../lib/fonts';
  import { activeAt, cueText, ORIGINAL_PREVIEW_STYLE, overlapping, type SubtitleStyle } from '../lib/subtitles';
  import { formatTime } from '../lib/time';
  import { app, controls, playback, renderPreview, requestStill } from '../state.svelte';

  let video: HTMLVideoElement | undefined = $state();
  let stage: HTMLDivElement | undefined = $state();
  let stageHeight = $state(0);
  /** What is being dragged: a caption (by id) or the subtitle block. */
  let drag: { id: string | null; dx: number; dy: number } | null = null;

  const included = $derived(app.subMode === 'off' ? [] : app.cues.filter((c) => !app.disabledCues.includes(c.line)));
  const subtitleNow = $derived(activeAt(included, app.current));
  // In 'My style' mode, show a dimmed sample when no line is on screen, so it can still be dragged.
  const subtitleSample = $derived(
    app.subMode === 'custom' && subtitleNow.length === 0 ? (overlapping(included, app.start, app.end)[0] ?? included[0]) : undefined,
  );
  const subtitleLines = $derived(
    (subtitleNow.length ? subtitleNow : subtitleSample ? [subtitleSample] : []).map((c) => cueText(c, app.cueOverrides)),
  );
  const subtitleLook = $derived<SubtitleStyle>(app.subMode === 'custom' ? app.settings.subtitleStyle : ORIGINAL_PREVIEW_STYLE);

  const dar = $derived(app.info?.dar ?? 16 / 9);
  const hasFrameCallback = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

  onMount(() => {
    controls.seek = (t) => {
      const time = Math.max(0, Math.min(app.info?.duration ?? 0, t));
      app.current = time;
      if (app.playable && video) video.currentTime = time;
      else requestStill(time);
    };
    controls.toggle = () => {
      if (!video || !app.playable) return;
      if (video.paused) {
        if (playback.loop && (app.current < app.start || app.current >= app.end)) video.currentTime = app.start;
        video.play();
      } else video.pause();
    };
    if (!app.playable) requestStill(app.current);
  });

  // Track the displayed frame precisely where requestVideoFrameCallback exists.
  $effect(() => {
    const v = video;
    if (!v || !hasFrameCallback) return;
    let handle = 0;
    const tick = (_: number, meta: VideoFrameCallbackMetadata) => {
      onTime(meta.mediaTime);
      handle = v.requestVideoFrameCallback(tick);
    };
    handle = v.requestVideoFrameCallback(tick);
    return () => v.cancelVideoFrameCallback(handle);
  });

  function onTime(t: number) {
    app.current = t;
    if (playback.loop && playback.playing && video && t >= app.end) video.currentTime = app.start;
  }

  function failed() {
    app.playable = false;
    requestStill(app.current);
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
    return (app.current >= o.start && app.current < o.end) || app.selected === o.id;
  }

  function pointerDown(e: PointerEvent, id: string | null, o: { x: number; y: number }) {
    if (!stage) return;
    if (id) app.selected = id;
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
</script>

<div class="card player">
  <div class="frame" bind:this={stage} bind:clientHeight={stageHeight} style:aspect-ratio={dar} style:--dar={dar}>
    {#if app.playable}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video
        bind:this={video}
        src={app.videoUrl}
        preload="auto"
        playsinline
        onerror={failed}
        onplay={() => (playback.playing = true)}
        onpause={() => (playback.playing = false)}
        ontimeupdate={() => video && !hasFrameCallback && onTime(video.currentTime)}
        onclick={() => controls.toggle()}
      ></video>
    {:else if app.stillUrl}
      <img src={app.stillUrl} alt="Frame at {formatTime(app.current)}" />
    {/if}
    <div class="layer">
      {#each app.overlays as o (o.id)}
        {#if visible(o)}
          <div
            class="text"
            class:selected={app.selected === o.id}
            class:inactive={!(app.current >= o.start && app.current < o.end)}
            style={overlayStyle(o)}
            role="button"
            tabindex="-1"
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
          title={app.subMode === 'custom' ? 'Drag to move the subtitles' : 'Approximate preview of the original styling'}
          onpointerdown={(e) => app.subMode === 'custom' && pointerDown(e, null, app.settings.subtitleStyle)}
          onpointermove={pointerMove}
          onpointerup={() => (drag = null)}
        >{subtitleLines.join('\n')}</div>
      {/if}
    </div>
  </div>
  <div class="row bar">
    <button onclick={() => controls.toggle()} disabled={!app.playable} title="Play/pause (Space)">
      {playback.playing ? 'Pause' : 'Play'}
    </button>
    <label class="row loop"><input type="checkbox" bind:checked={playback.loop} /> Loop selection</label>
    <span class="mono time">{formatTime(app.current)} / {formatTime(app.info?.duration ?? 0)}</span>
    <button onclick={renderPreview} disabled={!!app.busy} title="Render this frame with ffmpeg, including burned-in text">
      Preview exact frame
    </button>
  </div>
  {#if !app.playable}
    <p class="muted note">This browser can't play this file, so the preview shows still frames rendered by ffmpeg.</p>
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
  video,
  .frame img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: fill;
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
  .text.selected {
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
  .loop {
    gap: 0.3rem;
    font-size: 0.9rem;
  }
  .note {
    margin: 0;
    font-size: 0.85rem;
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
