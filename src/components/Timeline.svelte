<script lang="ts">
  import { formatTime, parseTime } from '../lib/time';
  import { app, controls, frameDuration, playback, setEnd, setEndHere, setStart, setStartHere } from '../state.svelte';

  const duration = $derived(app.info?.duration ?? 0);

  let startText = $state('');
  let endText = $state('');
  $effect(() => {
    startText = formatTime(app.start);
    endText = formatTime(app.end);
  });

  let track: HTMLDivElement | undefined = $state();
  let hover: { x: number; t: number } | null = $state(null);
  let dragging = false;

  function timeAt(clientX: number): number {
    if (!track) return 0;
    const r = track.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * duration;
  }

  function pct(t: number): string {
    return `${(t / (duration || 1)) * 100}%`;
  }

  function down(e: PointerEvent) {
    dragging = true;
    track?.setPointerCapture(e.pointerId);
    if (playback.playing) controls.toggle();
    controls.seek(timeAt(e.clientX));
  }

  function move(e: PointerEvent) {
    const r = track!.getBoundingClientRect();
    hover = { x: e.clientX - r.left, t: timeAt(e.clientX) };
    if (dragging) controls.seek(hover.t);
  }

  function key(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable]')) return;
    switch (e.key) {
      case ' ':
        controls.toggle();
        break;
      case 'ArrowLeft':
        if (e.shiftKey) controls.seek(app.current - 1);
        else controls.step(-1);
        break;
      case 'ArrowRight':
        if (e.shiftKey) controls.seek(app.current + 1);
        else controls.step(1);
        break;
      case 'i':
      case '[':
        setStartHere();
        break;
      case 'o':
      case ']':
        setEndHere();
        break;
      case 'l':
        playback.loop = !playback.loop;
        break;
      case 'm':
        playback.muted = !playback.muted;
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  function editTime(which: 'start' | 'end', text: string) {
    const t = parseTime(text);
    if (t !== null) (which === 'start' ? setStart : setEnd)(t);
    startText = formatTime(app.start);
    endText = formatTime(app.end);
  }
</script>

<svelte:window onkeydown={key} />

<div class="card timeline">
  <div
    class="track"
    bind:this={track}
    role="slider"
    tabindex="0"
    aria-label="Position in video"
    aria-valuemin={0}
    aria-valuemax={duration}
    aria-valuenow={app.current}
    aria-valuetext={formatTime(app.current)}
    onpointerdown={down}
    onpointermove={move}
    onpointerup={() => (dragging = false)}
    onpointerleave={() => (hover = null)}
  >
    <div class="range" style:left={pct(app.start)} style:width={pct(app.end - app.start)}></div>
    <div class="marker start" style:left={pct(app.start)} title="Clip start"></div>
    <div class="marker end" style:left={pct(app.end)} title="Clip end"></div>
    <div class="playhead" style:left={pct(app.current)}></div>
    {#if hover}<div class="hover mono" style:left="{hover.x}px">{formatTime(hover.t, 1)}</div>{/if}
  </div>

  <div class="row controls">
    <button class="small" onclick={() => controls.step(-1)} title="Previous frame (←; hold to scrub)">‹ Frame</button>
    <button class="small" onclick={() => controls.step(1)} title="Next frame (→; hold to scrub)">Frame ›</button>
    <button onclick={() => setStartHere()} title="Start the clip at this frame (I)">Set start</button>
    <button onclick={() => setEndHere()} title="End the clip after this frame (O)">Set end</button>
    <span class="length mono">Clip {formatTime(app.end - app.start)}</span>
  </div>

  <div class="row controls">
    <label class="row mini">
      Start
      <input class="mono" size="11" aria-label="Clip start time" bind:value={startText} onchange={() => editTime('start', startText)} />
    </label>
    <button class="small" onclick={() => controls.seek(app.start)}>Go to start</button>
    <label class="row mini">
      End
      <input class="mono" size="11" aria-label="Clip end time" bind:value={endText} onchange={() => editTime('end', endText)} />
    </label>
    <button class="small" onclick={() => controls.seek(Math.max(0, app.end - frameDuration()))}>Go to end</button>
  </div>

  <p class="keys muted">
    Drag the bar to scrub. <kbd>←</kbd><kbd>→</kbd> one frame (hold to scrub), <kbd>Shift</kbd> 1 s ·
    <kbd>I</kbd> set start · <kbd>O</kbd> set end · <kbd>Space</kbd> play · <kbd>M</kbd> mute
  </p>
</div>

<style>
  .timeline {
    display: grid;
    gap: 0.55rem;
  }
  .track {
    position: relative;
    height: 36px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 5px;
    cursor: pointer;
    touch-action: none;
  }
  .track:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .range {
    position: absolute;
    top: 0;
    bottom: 0;
    background: var(--accent-soft);
    pointer-events: none;
  }
  .marker {
    position: absolute;
    top: -4px;
    bottom: -4px;
    width: 3px;
    margin-left: -1.5px;
    background: var(--accent);
    pointer-events: none;
  }
  .marker::after {
    content: '';
    position: absolute;
    top: 0;
    width: 7px;
    height: 7px;
    background: var(--accent);
  }
  .marker.start::after {
    left: 0;
  }
  .marker.end::after {
    right: 0;
  }
  .playhead {
    position: absolute;
    top: -6px;
    bottom: -6px;
    width: 2px;
    margin-left: -1px;
    background: var(--text);
    pointer-events: none;
  }
  .hover {
    position: absolute;
    bottom: calc(100% + 6px);
    transform: translateX(-50%);
    font-size: 0.75rem;
    padding: 0.1rem 0.35rem;
    border-radius: 4px;
    background: var(--text);
    color: var(--bg);
    pointer-events: none;
    white-space: nowrap;
  }
  .controls {
    align-items: center;
  }
  .mini {
    gap: 0.35rem;
    font-size: 0.88rem;
    color: var(--muted);
  }
  .length {
    margin-left: auto;
    font-weight: 600;
  }
  .keys {
    font-size: 0.8rem;
    margin: 0;
  }
</style>
