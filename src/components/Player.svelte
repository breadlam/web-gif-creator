<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { TextOverlay } from '../lib/ass';
  import { AudioPreview } from '../lib/audioPreview';
  import { font } from '../lib/fonts';
  import { activeAt, cueText, ORIGINAL_PREVIEW_STYLE, overlapping, type SubtitleStyle } from '../lib/subtitles';
  import { formatTime } from '../lib/time';
  import { app, audioSource, controls, nativeVideo, playback, renderPreview, requestStill } from '../state.svelte';

  let video: HTMLVideoElement | undefined = $state();
  let audio: HTMLAudioElement | undefined = $state();
  let stage: HTMLDivElement | undefined = $state();
  let stageHeight = $state(0);
  /** What is being dragged: a caption (by id) or the subtitle block. */
  let drag: { id: string | null; dx: number; dy: number } | null = null;

  const dar = $derived(app.info?.dar ?? 16 / 9);
  const duration = $derived(app.info?.duration ?? 0);
  const showVideo = $derived(nativeVideo());
  const source = $derived(audioSource());
  const hasFrameCallback = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

  // ffmpeg-decoded sound, for when the browser can't play the selected track.
  const sound = new AudioPreview();
  let soundState: '' | 'loading' | string = $state('');
  let refilling = false;
  $effect(() => sound.setFile(app.file));
  $effect(() => {
    if (audio) sound.attach(audio);
  });

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

  // Volume, mute and speed apply to whichever element is making the sound.
  $effect(() => {
    if (!video) return;
    video.volume = playback.volume;
    video.playbackRate = playback.rate;
    video.muted = playback.muted || source.mode !== 'native';
  });
  $effect(() => {
    if (!audio) return;
    audio.volume = playback.volume;
    audio.playbackRate = playback.rate;
    audio.muted = playback.muted;
  });
  // Changing track or sound source mid-playback: stop (resume() restarts where needed).
  $effect(() => {
    void app.audioTrack;
    void source.mode;
    void app.info?.videoIndex;
    untrack(stop);
  });

  onMount(() => {
    controls.seek = (t) => {
      const time = Math.max(0, Math.min(duration, t));
      app.current = time;
      if (showVideo && video) video.currentTime = time;
      else {
        if (playback.playing && source.mode === 'ffmpeg') followSound(time);
        else requestStill(time);
      }
    };
    controls.toggle = () => (playback.playing ? stop() : start());
    if (!showVideo) requestStill(app.current);
    return () => stop();
  });

  async function start() {
    const loopFrom = playback.loop && (app.current < app.start || app.current >= app.end - 0.05);
    const from = loopFrom ? app.start : app.current;
    const ffSound = source.mode === 'ffmpeg' && app.audioTrack !== null;
    if (!showVideo && !ffSound) return;
    if (ffSound) {
      soundState = 'loading';
      try {
        await sound.prepare(app.audioTrack!, from, duration);
        soundState = '';
      } catch (e) {
        soundState = `Couldn't decode the sound: ${e instanceof Error ? e.message : e}`;
      }
    }
    if (showVideo && video) {
      video.currentTime = from;
      await video.play().catch(() => undefined);
    } else {
      app.current = from;
      playback.playing = true;
      requestAnimationFrame(clock);
    }
    if (ffSound && !soundState) sound.play(from).catch(() => undefined);
  }

  function stop() {
    video?.pause();
    sound.pause();
    if (!showVideo && playback.playing) requestStill(app.current);
    playback.playing = false;
  }

  /** Keep ffmpeg sound with the playhead, loading the next stretch when it runs out. */
  function followSound(t: number) {
    if (source.mode !== 'ffmpeg' || app.audioTrack === null || refilling) return;
    if (sound.sync(app.audioTrack, t)) return;
    refilling = true;
    sound.pause();
    soundState = 'loading';
    sound
      .prepare(app.audioTrack, t, duration)
      .then(() => {
        soundState = '';
        if (playback.playing) return sound.play(showVideo && video ? video.currentTime : t);
      })
      .catch((e) => (soundState = `Couldn't decode the sound: ${e instanceof Error ? e.message : e}`))
      .finally(() => (refilling = false));
  }

  // Without a playable video, the sound drives the playhead; stills follow occasionally.
  let lastStill = 0;
  function clock(now: number) {
    if (!playback.playing || showVideo) return;
    const t = sound.time();
    if (!Number.isNaN(t) && !refilling) {
      app.current = t;
      if (playback.loop && t >= app.end) {
        app.current = app.start;
        if (sound.covers(app.audioTrack!, app.start)) sound.play(app.start);
        else followSound(app.start);
      } else if (!sound.covers(app.audioTrack!, t)) followSound(t);
      if (now - lastStill > 1500) {
        lastStill = now;
        requestStill(app.current);
      }
    }
    requestAnimationFrame(clock);
  }

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
    else if (playback.playing) followSound(t);
  }

  /**
   * Some files play without sound even though the codec looks supported (e.g. an
   * unsupported audio profile). After a moment of playback, check whether any audio was
   * decoded, and switch to ffmpeg sound if not.
   */
  function checkSound() {
    if (source.mode !== 'native') return;
    setTimeout(() => {
      const v = video as (HTMLVideoElement & { webkitAudioDecodedByteCount?: number; mozHasAudio?: boolean }) | undefined;
      if (!v || v.paused || source.mode !== 'native') return;
      const silent = typeof v.webkitAudioDecodedByteCount === 'number'
        ? v.webkitAudioDecodedByteCount === 0
        : v.mozHasAudio === false;
      if (!silent) return;
      // Switching the source stops playback (see the effect above); carry on with ffmpeg sound.
      app.nativeAudioFailed = true;
      setTimeout(start, 0);
    }, 1500);
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
    {#if showVideo}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video
        bind:this={video}
        src={app.videoUrl}
        preload="auto"
        playsinline
        onerror={failed}
        onplay={() => (playback.playing = true)}
        onplaying={checkSound}
        onpause={() => {
          playback.playing = false;
          sound.pause();
        }}
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
  <audio bind:this={audio} preload="auto" hidden></audio>

  <div class="row bar">
    <button
      onclick={() => controls.toggle()}
      disabled={!showVideo && source.mode !== 'ffmpeg'}
      title="Play/pause (Space)"
    >
      {playback.playing ? 'Pause' : 'Play'}
    </button>
    <label class="row opt"><input type="checkbox" bind:checked={playback.loop} /> Loop selection</label>
    <span class="mono time">{formatTime(app.current)} / {formatTime(duration)}</span>
    <button onclick={renderPreview} disabled={!!app.busy} title="Render this frame with ffmpeg, including burned-in text">
      Preview exact frame
    </button>
  </div>
  <div class="row bar sound">
    {#if source.mode === 'none'}
      <span class="muted">{app.info?.audio.length ? 'Sound off' : 'This video has no audio'}</span>
    {:else}
      <button class="small" onclick={() => (playback.muted = !playback.muted)} title="Mute (M)">
        {playback.muted ? 'Unmute' : 'Mute'}
      </button>
      <input type="range" min="0" max="1" step="0.05" bind:value={playback.volume} aria-label="Volume" />
      <label class="row opt">
        Speed
        <select bind:value={playback.rate} aria-label="Playback speed">
          {#each [0.5, 0.75, 1, 1.25] as r}<option value={r}>{r}×</option>{/each}
        </select>
      </label>
      <span class="muted status">
        {#if soundState === 'loading'}
          Decoding sound…
        {:else if soundState}
          <span class="warn">{soundState}</span>
        {:else if source.mode === 'ffmpeg'}
          Sound decoded by ffmpeg ({source.reason})
        {/if}
      </span>
    {/if}
  </div>
  {#if !showVideo}
    <p class="muted note">
      {app.playable ? 'The browser can only show the first video track,' : "This browser can't play this file,"}
      so the preview shows still frames rendered by ffmpeg.
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
