<script lang="ts">
  import { app, openVideo } from '../state.svelte';

  let over = $state(false);
  let input: HTMLInputElement | undefined = $state();

  function drop(e: DragEvent) {
    e.preventDefault();
    over = false;
    const f = e.dataTransfer?.files[0];
    if (f) openVideo(f);
  }
</script>

<div
  class="drop"
  class:over
  role="button"
  tabindex="0"
  ondragover={(e) => {
    e.preventDefault();
    over = true;
  }}
  ondragleave={() => (over = false)}
  ondrop={drop}
  onclick={() => input?.click()}
  onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && input?.click()}
>
  <p class="big">Drop a video here, or click to choose one</p>
  <p class="muted">
    Everything runs in your browser with ffmpeg compiled to WebAssembly. The video is never uploaded.
  </p>
  {#if app.engine === 'loading'}
    <p class="muted">Loading ffmpeg (about 32 MB the first time; cached afterwards)…</p>
  {/if}
  <input
    bind:this={input}
    type="file"
    accept="video/*,.mkv"
    hidden
    onchange={(e) => {
      const f = e.currentTarget.files?.[0];
      if (f) openVideo(f);
    }}
  />
</div>

<style>
  .drop {
    margin: 3rem auto;
    max-width: 720px;
    padding: 3.5rem 2rem;
    text-align: center;
    border: 2px dashed var(--border);
    border-radius: 14px;
    background: var(--surface);
    cursor: pointer;
  }
  .drop.over,
  .drop:focus-visible {
    border-color: var(--accent);
    background: var(--accent-soft);
    outline: none;
  }
  .big {
    font-size: 1.2rem;
    font-weight: 600;
    margin: 0 0 0.6rem;
  }
</style>
