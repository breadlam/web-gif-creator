<script lang="ts">
  import { onMount } from 'svelte';
  import DropZone from './components/DropZone.svelte';
  import Log from './components/Log.svelte';
  import Output from './components/Output.svelte';
  import Overlays from './components/Overlays.svelte';
  import Player from './components/Player.svelte';
  import Settings from './components/Settings.svelte';
  import Subtitles from './components/Subtitles.svelte';
  import Timeline from './components/Timeline.svelte';
  import Tracks from './components/Tracks.svelte';
  import { engine } from './lib/engine';
  import { app, cancel, openVideo, saveSettings } from './state.svelte';

  let picker: HTMLInputElement | undefined = $state();

  onMount(() => {
    engine.load().then(
      () => (app.engine = 'ready'),
      (e) => {
        app.engine = 'failed';
        app.error = `Couldn't load ffmpeg: ${e instanceof Error ? e.message : e}`;
      },
    );
  });

  $effect(() => saveSettings($state.snapshot(app.settings)));

  function picked(e: Event) {
    const f = (e.currentTarget as HTMLInputElement).files?.[0];
    if (f) openVideo(f);
  }

  // Dropping a file anywhere opens it (replacing the current video) instead of letting
  // the browser navigate to it. dragenter/dragleave fire for every child element, so
  // count them to know when the drag has left the window.
  let dragDepth = $state(0);
  const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');

  function dragEnter(e: DragEvent) {
    if (hasFiles(e)) dragDepth++;
  }
  function dragLeave(e: DragEvent) {
    if (hasFiles(e)) dragDepth = Math.max(0, dragDepth - 1);
  }
  function dragOver(e: DragEvent) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
  }
  function drop(e: DragEvent) {
    dragDepth = 0;
    // The empty-state drop zone handles its own drops.
    if (!hasFiles(e) || e.defaultPrevented) return;
    e.preventDefault();
    const f = e.dataTransfer!.files[0];
    if (f) openVideo(f);
  }
</script>

<svelte:window ondragenter={dragEnter} ondragleave={dragLeave} ondragover={dragOver} ondrop={drop} />

{#if dragDepth > 0 && app.info}
  <div class="drop-overlay" aria-hidden="true">
    <div>Drop to open this video<span>It replaces the current one.</span></div>
  </div>
{/if}

<header>
  <h1>Web GIF Creator</h1>
  <span class="engine muted" data-state={app.engine}>
    {app.engine === 'loading' ? 'Loading ffmpeg…' : app.engine === 'ready' ? 'ffmpeg ready' : 'ffmpeg failed to load'}
  </span>
  {#if app.file}
    <span class="file mono" title={app.file.name}>{app.file.name}</span>
    <button onclick={() => picker?.click()}>Open another video</button>
  {/if}
  <input bind:this={picker} type="file" accept="video/*,.mkv" hidden onchange={picked} />
</header>

{#if app.error}
  <div class="error" role="alert">
    <pre>{app.error}</pre>
    <button class="small" onclick={() => (app.error = '')}>Dismiss</button>
  </div>
{/if}

{#if app.busy}
  <div class="busy" role="status">
    <span>{app.busy.label}…</span>
    <progress max="1" value={app.busy.fraction ?? undefined}></progress>
    <button class="small" onclick={cancel}>Cancel</button>
  </div>
{/if}

{#if !app.info}
  <DropZone />
{:else if app.info.unsupported}
  <div class="unsupported">
    <div class="card">
      <h2>Can't decode this video</h2>
      <p>{app.info.unsupported}</p>
    </div>
    {#if app.info.videos.length > 1}<Tracks />{/if}
  </div>
{:else}
  <main>
    <section class="stage">
      <Player />
      <Timeline />
      <Overlays />
    </section>
    <aside>
      <Tracks />
      <Settings />
      <Subtitles />
      <Output />
    </aside>
  </main>
{/if}

<Log />

<style>
  header {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.7rem 1.2rem;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }
  h1 {
    font-size: 1.1rem;
  }
  .engine {
    font-size: 0.85rem;
  }
  .engine[data-state='ready'] {
    color: var(--ok);
  }
  .engine[data-state='failed'] {
    color: var(--danger);
  }
  .file {
    margin-left: auto;
    max-width: 40ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.85rem;
  }
  main {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 360px;
    gap: 1rem;
    padding: 1rem 1.2rem;
    align-items: start;
  }
  .stage,
  aside {
    display: grid;
    gap: 1rem;
    min-width: 0;
  }
  @media (max-width: 960px) {
    main {
      grid-template-columns: minmax(0, 1fr);
      padding: 1rem;
    }
  }
  .error {
    margin: 1rem 1.2rem 0;
    padding: 0.6rem 0.9rem;
    border: 1px solid var(--danger);
    border-radius: var(--radius);
    color: var(--danger);
    display: flex;
    gap: 1rem;
    align-items: start;
  }
  .error pre {
    margin: 0;
    white-space: pre-wrap;
    font-size: 0.85rem;
    flex: 1;
  }
  /* Floats over the page instead of pushing it down, so nothing jumps when work starts
     or finishes (e.g. mid-drag on the timeline). */
  .busy {
    position: fixed;
    top: 0.6rem;
    left: 50%;
    transform: translateX(-50%);
    z-index: 50;
    display: flex;
    gap: 0.8rem;
    align-items: center;
    width: min(640px, calc(100% - 2rem));
    padding: 0.5rem 1rem;
    background: var(--surface);
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    box-shadow: 0 4px 18px rgba(0, 0, 0, 0.18);
  }
  .busy progress {
    flex: 1;
    max-width: 420px;
  }
  .drop-overlay {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: grid;
    place-items: center;
    background: rgba(0, 0, 0, 0.45);
    pointer-events: none;
  }
  .drop-overlay div {
    display: grid;
    gap: 0.3rem;
    text-align: center;
    padding: 2rem 3rem;
    border: 2px dashed var(--accent);
    border-radius: 14px;
    background: var(--surface);
    font-size: 1.2rem;
    font-weight: 600;
  }
  .drop-overlay span {
    font-size: 0.9rem;
    font-weight: 400;
    color: var(--muted);
  }
  .unsupported {
    margin: 2rem auto;
    max-width: 640px;
    display: grid;
    gap: 1rem;
  }
</style>
