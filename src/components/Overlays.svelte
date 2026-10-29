<script lang="ts">
  import { FONTS } from '../lib/fonts';
  import { formatTime, parseTime } from '../lib/time';
  import { addOverlay, app, removeOverlay } from '../state.svelte';

  function setTime(o: { start: number; end: number }, which: 'start' | 'end', text: string) {
    const t = parseTime(text);
    if (t !== null) o[which] = t;
  }
</script>

<div class="card">
  <div class="row head">
    <h2>Text</h2>
    <button class="small" onclick={addOverlay}>Add text</button>
  </div>
  {#if app.overlays.length === 0}
    <p class="muted note">Add a caption, then drag it into place on the video. Each caption can have its own timing.</p>
  {/if}
  {#each app.overlays as o (o.id)}
    <div
      class="overlay"
      class:selected={app.selected === o.id}
      role="group"
      onfocusin={() => (app.selected = o.id)}
      onpointerdown={() => (app.selected = o.id)}
    >
      <textarea rows="2" bind:value={o.text} aria-label="Caption text"></textarea>
      <div class="row">
        <select bind:value={o.font} aria-label="Font">
          {#each FONTS as f}<option value={f.id}>{f.label}</option>{/each}
        </select>
        <label class="row mini">Size <input type="range" min="3" max="30" step="0.5" bind:value={o.size} /></label>
        <label class="row mini">Outline <input type="range" min="0" max="3" step="0.1" bind:value={o.outline} /></label>
        <input type="color" bind:value={o.color} aria-label="Text colour" />
        <input type="color" bind:value={o.outlineColor} aria-label="Outline colour" />
      </div>
      <div class="row">
        <label class="row mini">From <input class="mono" size="9" value={formatTime(o.start, 2)} onchange={(e) => setTime(o, 'start', e.currentTarget.value)} /></label>
        <label class="row mini">to <input class="mono" size="9" value={formatTime(o.end, 2)} onchange={(e) => setTime(o, 'end', e.currentTarget.value)} /></label>
        <button class="small" onclick={() => ((o.start = app.start), (o.end = app.end))}>Whole clip</button>
        <button class="small" onclick={() => (o.x = 0.5)}>Centre</button>
        <button class="small danger" onclick={() => removeOverlay(o.id)}>Remove</button>
      </div>
    </div>
  {/each}
</div>

<style>
  .head {
    justify-content: space-between;
    margin-bottom: 0.4rem;
  }
  .head h2 {
    margin: 0;
  }
  .note {
    font-size: 0.85rem;
    margin: 0;
  }
  .overlay {
    display: grid;
    gap: 0.45rem;
    padding: 0.6rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    margin-top: 0.5rem;
  }
  .overlay.selected {
    border-color: var(--accent);
  }
  textarea {
    width: 100%;
    resize: vertical;
  }
  .mini {
    gap: 0.3rem;
    font-size: 0.85rem;
    color: var(--muted);
  }
  .mini input[type='range'] {
    width: 90px;
  }
  .danger {
    color: var(--danger);
  }
</style>
