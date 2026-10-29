<script lang="ts">
  import { formatTime, parseTime } from '../lib/time';
  import { app, controls, playback } from '../state.svelte';

  const duration = $derived(app.info?.duration ?? 0);
  const frame = $derived(1 / (app.info?.fps || 25));
  // Zoomed view around the selection, for frame-level trimming.
  const pad = $derived(Math.max(1.5, (app.end - app.start) * 0.35));
  const zoom = $derived({ from: Math.max(0, app.start - pad), to: Math.min(duration, app.end + pad) });

  let startText = $state('');
  let endText = $state('');
  $effect(() => {
    startText = formatTime(app.start);
    endText = formatTime(app.end);
  });

  function setStart(t: number) {
    app.start = Math.max(0, Math.min(t, app.end - frame));
  }
  function setEnd(t: number) {
    app.end = Math.min(duration, Math.max(t, app.start + frame));
  }

  type Grab = 'start' | 'end' | 'seek';
  let grab: { what: Grab; el: HTMLElement; from: number; to: number } | null = null;

  function timeAt(e: PointerEvent, from: number, to: number, el: HTMLElement): number {
    const r = el.getBoundingClientRect();
    return from + Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * (to - from);
  }

  function down(e: PointerEvent, what: Grab, from: number, to: number) {
    const el = (e.currentTarget as HTMLElement).closest('.track') as HTMLElement;
    grab = { what, el, from, to };
    el.setPointerCapture(e.pointerId);
    e.stopPropagation();
    move(e);
  }

  function move(e: PointerEvent) {
    if (!grab) return;
    const t = timeAt(e, grab.from, grab.to, grab.el);
    if (grab.what === 'start') setStart(t);
    else if (grab.what === 'end') setEnd(t);
    if (grab.what === 'seek' || !playback.playing) controls.seek(t);
  }

  function pct(t: number, from: number, to: number): string {
    return `${((t - from) / (to - from || 1)) * 100}%`;
  }

  function key(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable]')) return;
    const step = e.shiftKey ? 1 : frame;
    switch (e.key) {
      case ' ':
        controls.toggle();
        break;
      case 'ArrowLeft':
        controls.seek(app.current - step);
        break;
      case 'ArrowRight':
        controls.seek(app.current + step);
        break;
      case 'i':
      case '[':
        setStart(app.current);
        break;
      case 'o':
      case ']':
        setEnd(app.current);
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
</script>

<svelte:window onkeydown={key} />

<div class="card timeline">
  {#each [{ from: 0, to: duration, label: 'Whole video' }, { from: zoom.from, to: zoom.to, label: 'Selection (zoomed)' }] as bar}
    <div class="bar-label muted">
      <span>{bar.label}</span>
      <span class="mono">{formatTime(bar.from, 1)} – {formatTime(bar.to, 1)}</span>
    </div>
    <div
      class="track"
      role="slider"
      tabindex="-1"
      aria-label="{bar.label} timeline"
      aria-valuenow={app.current}
      onpointerdown={(e) => down(e, 'seek', bar.from, bar.to)}
      onpointermove={move}
      onpointerup={() => (grab = null)}
    >
      <div class="range" style:left={pct(app.start, bar.from, bar.to)} style:width={pct(app.end - app.start + bar.from, bar.from, bar.to)}></div>
      <div
        class="handle"
        style:left={pct(app.start, bar.from, bar.to)}
        role="slider"
        tabindex="-1"
        aria-label="Clip start"
        aria-valuenow={app.start}
        onpointerdown={(e) => down(e, 'start', bar.from, bar.to)}
      ></div>
      <div
        class="handle end"
        style:left={pct(app.end, bar.from, bar.to)}
        role="slider"
        tabindex="-1"
        aria-label="Clip end"
        aria-valuenow={app.end}
        onpointerdown={(e) => down(e, 'end', bar.from, bar.to)}
      ></div>
      <div class="playhead" style:left={pct(app.current, bar.from, bar.to)}></div>
    </div>
  {/each}

  <div class="row controls">
    <label class="field">
      Start
      <input
        class="mono"
        size="11"
        bind:value={startText}
        onchange={() => {
          const t = parseTime(startText);
          if (t !== null) setStart(t);
          startText = formatTime(app.start);
        }}
      />
    </label>
    <button class="small" onclick={() => setStart(app.current)} title="Set start to playhead (I or [)">Set start</button>
    <label class="field">
      End
      <input
        class="mono"
        size="11"
        bind:value={endText}
        onchange={() => {
          const t = parseTime(endText);
          if (t !== null) setEnd(t);
          endText = formatTime(app.end);
        }}
      />
    </label>
    <button class="small" onclick={() => setEnd(app.current)} title="Set end to playhead (O or ])">Set end</button>
    <span class="length mono">Length {formatTime(app.end - app.start)}</span>
  </div>
  <div class="row nav">
    <button class="small" onclick={() => controls.seek(app.start)}>Go to start</button>
    <button class="small" onclick={() => controls.seek(app.current - frame)} title="Previous frame (←)">‹ Frame</button>
    <button class="small" onclick={() => controls.seek(app.current + frame)} title="Next frame (→)">Frame ›</button>
    <button class="small" onclick={() => controls.seek(app.end)}>Go to end</button>
    <span class="muted keys"><kbd>Space</kbd> play <kbd>←</kbd><kbd>→</kbd> frame (<kbd>Shift</kbd> 1 s) <kbd>I</kbd>/<kbd>O</kbd> set start/end <kbd>M</kbd> mute</span>
  </div>
</div>

<style>
  .timeline {
    display: grid;
    gap: 0.35rem;
  }
  .bar-label {
    display: flex;
    justify-content: space-between;
    font-size: 0.8rem;
  }
  .track {
    position: relative;
    height: 30px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 5px;
    cursor: pointer;
    touch-action: none;
    margin-bottom: 0.4rem;
  }
  .range {
    position: absolute;
    top: 0;
    bottom: 0;
    background: var(--accent-soft);
    border-left: 2px solid var(--accent);
    border-right: 2px solid var(--accent);
  }
  .handle {
    position: absolute;
    top: -3px;
    bottom: -3px;
    width: 12px;
    margin-left: -6px;
    background: var(--accent);
    border-radius: 3px;
    cursor: ew-resize;
  }
  .playhead {
    position: absolute;
    top: -4px;
    bottom: -4px;
    width: 2px;
    margin-left: -1px;
    background: var(--text);
    pointer-events: none;
  }
  .controls {
    align-items: end;
    margin-top: 0.3rem;
  }
  .length {
    margin-left: auto;
    font-weight: 600;
  }
  .keys {
    margin-left: auto;
    font-size: 0.8rem;
  }
</style>
