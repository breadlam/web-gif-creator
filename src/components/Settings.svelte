<script lang="ts">
  import { DITHERS, MODEL } from '../lib/sizeModel';
  import { app, outputSize } from '../state.svelte';

  const HEIGHTS = [720, 540, 480, 360, 270];
  const size = $derived(outputSize());
  const accuracy = $derived(MODEL.models[app.settings.dither].heldOut);
</script>

<div class="card">
  <h2>Output</h2>
  <div class="grid">
    <label class="field">
      Max file size (MB)
      <input type="number" min="0.5" step="0.5" bind:value={app.settings.maxMB} />
    </label>
    <label class="field">
      Height
      <select bind:value={app.settings.height}>
        {#each HEIGHTS as h}<option value={h}>{h}p</option>{/each}
        {#if !HEIGHTS.includes(app.settings.height)}<option value={app.settings.height}>{app.settings.height}p</option>{/if}
      </select>
    </label>
    <label class="field wide">
      Dithering
      <select bind:value={app.settings.dither}>
        {#each DITHERS as d}<option value={d.id}>{d.label}</option>{/each}
      </select>
    </label>
    <label class="field">
      Frame rate
      <select bind:value={app.settings.fpsMode}>
        <option value="auto">Max for size</option>
        <option value="manual">Fixed</option>
      </select>
    </label>
    {#if app.settings.fpsMode === 'manual'}
      <label class="field">
        FPS
        <input type="number" min="1" max="50" step="1" bind:value={app.settings.manualFps} />
      </label>
    {/if}
  </div>
  <label class="row check">
    <input type="checkbox" bind:checked={app.settings.uniform} />
    Even frame timing (rates of 100/n: 50, 33.3, 25, 20, 16.7…)
  </label>
  <p class="muted note">
    {size.width}×{size.height}. In calibration on unseen footage, GIFs planned with this
    dithering mode used {Math.round(accuracy.utilization * 100)}% of the budget on
    average{#if accuracy.overBudget > 0}, and {Math.round(accuracy.overBudget * 100)}% came out
      over it (by up to {Math.round(accuracy.worstOverBudget * 100)}%){/if}.
  </p>
</div>

<style>
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.6rem;
  }
  .wide {
    grid-column: 1 / -1;
  }
  .grid input,
  .grid select {
    width: 100%;
  }
  .check {
    margin-top: 0.6rem;
    font-size: 0.88rem;
    gap: 0.4rem;
    flex-wrap: nowrap;
  }
  .note {
    font-size: 0.82rem;
    margin: 0.5rem 0 0;
  }
</style>
