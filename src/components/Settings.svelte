<script lang="ts">
  import { calibratedHeights, DITHERS, modelFor } from '../lib/sizeModel';
  import { app, outputSize } from '../state.svelte';
  import NumberField from './NumberField.svelte';

  const s = $derived(app.settings);
  const size = $derived(outputSize());
  const sourceHeight = $derived(app.info?.height ?? 0);
  const accuracy = $derived(modelFor({ mode: s.dither, bayerScale: s.bayerScale }).heldOut);
  const [calLow, calHigh] = calibratedHeights();

  const SIZES_MB = [1, 2, 5, 8, 10, 15, 20, 25, 50, 100].map((v) => ({ value: v, label: `${v} MB` }));
  const HEIGHTS = $derived([
    ...(sourceHeight ? [{ value: sourceHeight, label: `Source (${sourceHeight}p)` }] : []),
    ...[2160, 1440, 1080, 720, 576, 540, 480, 360, 270, 240, 180, 144].map((v) => ({ value: v, label: `${v}p` })),
  ]);
  const WIDTHS = [1920, 1280, 1024, 960, 854, 800, 720, 640, 600, 480, 400, 320, 240].map((v) => ({ value: v, label: `${v} px` }));
  const RATES = [
    5, 8, 10, 12, 12.5, 15, 100 / 6, 20, 23.976, 24, 25, 29.97, 30, 100 / 3, 50,
  ].map((v) => ({ value: Math.round(v * 1000) / 1000, label: `${Math.round(v * 100) / 100} fps` }));

  /** Height for a requested width at the source aspect ratio, rounded to even. */
  function heightForWidth(w: number): number {
    const dar = app.info?.dar ?? 16 / 9;
    return Math.max(2, Math.round(w / dar / 2) * 2);
  }

  /** The rate a fixed fps becomes with even frame timing (100/n). */
  function evenRate(fps: number): number {
    return 100 / Math.max(2, Math.ceil(100 / fps - 1e-9));
  }
</script>

<div class="card">
  <h2>Output</h2>
  <div class="fields">
    <span class="label">Max size</span>
    <NumberField label="Max file size" bind:value={app.settings.maxMB} min={0.05} max={10000} suffix="MB" presets={SIZES_MB} />

    <span class="label">Size</span>
    <span class="size">
      <NumberField
        label="Width"
        value={size.width}
        min={16}
        max={7680}
        even
        size={5}
        presets={WIDTHS}
        onchange={(w) => (app.settings.height = heightForWidth(w))}
      />
      <span class="muted">×</span>
      <NumberField label="Height" bind:value={app.settings.height} min={16} max={4320} even size={5} presets={HEIGHTS} />
    </span>

    <span class="label">Dithering</span>
    <span class="row">
      <select bind:value={app.settings.dither} aria-label="Dithering">
        {#each DITHERS as d}<option value={d.id}>{d.label}</option>{/each}
      </select>
      {#if s.dither === 'bayer'}
        <label class="row mini">
          Scale
          <NumberField label="Bayer scale" bind:value={app.settings.bayerScale} min={0} max={5} integer size={2} />
        </label>
      {/if}
    </span>

    <span class="label">Frame rate</span>
    <span class="row">
      <select bind:value={app.settings.fpsMode} aria-label="Frame rate mode">
        <option value="auto">Max for size</option>
        <option value="manual">Fixed</option>
      </select>
      {#if s.fpsMode === 'manual'}
        <NumberField label="Frames per second" bind:value={app.settings.manualFps} min={0.1} max={50} suffix="fps" size={5} presets={RATES} />
      {/if}
    </span>
  </div>

  <label class="row check">
    <input type="checkbox" bind:checked={app.settings.uniform} />
    Even frame timing (rates of 100/n: 50, 33.3, 25, 20, 16.7…)
  </label>

  <div class="notes muted">
    {#if s.dither === 'bayer'}<p>Bayer scale 0 is the strongest pattern, 5 the subtlest.</p>{/if}
    {#if sourceHeight && s.height > sourceHeight}
      <p class="warn">Larger than the source ({sourceHeight}p), so the video will be upscaled.</p>
    {/if}
    {#if s.height < calLow || s.height > calHigh}
      <p>Size estimates were calibrated at {calLow}–{calHigh}p; at {s.height}p they're extrapolated and less certain.</p>
    {/if}
    {#if s.fpsMode === 'manual' && s.uniform && Math.abs(evenRate(s.manualFps) - s.manualFps) > 0.005}
      <p>With even frame timing, {s.manualFps} fps becomes {evenRate(s.manualFps).toFixed(2)} fps.</p>
    {/if}
    {#if s.fpsMode === 'manual' && app.info && s.manualFps > app.info.fps + 0.01}
      <p>The source is {app.info.fps.toFixed(2)} fps; a higher rate would only repeat frames, so it's capped there.</p>
    {/if}
    <p>
      In calibration on unseen footage, GIFs planned with this dithering used
      {Math.round(accuracy.utilization * 100)}% of the budget on
      average{#if accuracy.overBudget > 0}, and {Math.round(accuracy.overBudget * 100)}% came out
        over it (by up to {Math.round(accuracy.worstOverBudget * 100)}%){/if}.
    </p>
  </div>
</div>

<style>
  .fields {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 0.5rem 0.7rem;
    align-items: center;
  }
  .label {
    font-size: 0.88rem;
    color: var(--muted);
  }
  .size {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.3rem;
  }
  .mini {
    gap: 0.3rem;
    font-size: 0.85rem;
    color: var(--muted);
  }
  .check {
    margin-top: 0.7rem;
    font-size: 0.88rem;
    gap: 0.4rem;
    flex-wrap: nowrap;
  }
  .notes {
    font-size: 0.82rem;
  }
  .notes p {
    margin: 0.4rem 0 0;
  }
  .warn {
    color: var(--warn);
  }
</style>
