<script lang="ts">
  import { AUTO_MAX_FPS, calibratedHeights, DITHERS, modelFor } from '../lib/sizeModel';
  import { app, outputSize } from '../state.svelte';
  import PresetSelect from './PresetSelect.svelte';

  const s = $derived(app.settings);
  const size = $derived(outputSize());
  const sourceHeight = $derived(app.info?.height ?? 0);
  const accuracy = $derived(modelFor({ mode: s.dither, bayerScale: s.bayerScale }).heldOut);
  const [calLow, calHigh] = calibratedHeights();

  const SIZES_MB = [1, 2, 5, 8, 10, 15, 20, 25, 50, 100].map((v) => ({ value: v, label: `${v} MB` }));
  const HEIGHTS = $derived([
    ...(sourceHeight ? [{ value: sourceHeight, label: `Source (${sourceHeight}p)` }] : []),
    ...[2160, 1440, 1080, 720, 576, 540, 480, 360, 270, 240, 180, 144]
      .filter((v) => v !== sourceHeight)
      .map((v) => ({ value: v, label: `${v}p` })),
  ]);
  // GIFs rarely benefit from more than 30 fps; 100/n rates give perfectly even frame timing.
  const RATES = [30, 25, 24, 20, 100 / 6, 15, 100 / 7, 12.5, 12, 100 / 9, 10, 8, 5].map((v) => ({
    value: v,
    label: `${Math.round(v * 100) / 100} fps`,
  }));

  // One dropdown for the frame rate: calculated, a preset, or custom.
  const AUTO = 'auto';
  const CUSTOM = 'custom';
  let customFps = $state(false);
  const rateIndex = $derived(RATES.findIndex((r) => Math.abs(r.value - s.manualFps) < 1e-3));
  const rateChoice = $derived(s.fpsMode === 'auto' ? AUTO : customFps || rateIndex < 0 ? CUSTOM : String(rateIndex));
  let fpsDraft = $state('');
  $effect(() => {
    fpsDraft = String(Math.round(s.manualFps * 1000) / 1000);
  });

  function pickRate(v: string) {
    if (v === AUTO) {
      app.settings.fpsMode = 'auto';
      customFps = false;
    } else if (v === CUSTOM) {
      app.settings.fpsMode = 'manual';
      customFps = true;
    } else {
      app.settings.fpsMode = 'manual';
      app.settings.manualFps = RATES[Number(v)].value;
      customFps = false;
    }
  }

  function commitFps() {
    const v = parseFloat(fpsDraft);
    if (Number.isFinite(v)) app.settings.manualFps = Math.min(1000, Math.max(0.1, v));
    fpsDraft = String(Math.round(s.manualFps * 1000) / 1000);
  }
</script>

<div class="card">
  <h2>Output</h2>
  <div class="fields">
    <span class="label">Max size</span>
    <PresetSelect label="Max file size" bind:value={app.settings.maxMB} presets={SIZES_MB} min={0.05} max={10000} suffix="MB" />

    <span class="label">Height</span>
    <span class="row">
      <PresetSelect label="Height" bind:value={app.settings.height} presets={HEIGHTS} min={16} max={4320} even suffix="px" />
      <span class="muted dims">{size.width}×{size.height}</span>
    </span>

    <span class="label">Frame rate</span>
    <span class="row">
      <select value={rateChoice} onchange={(e) => pickRate(e.currentTarget.value)} aria-label="Frame rate">
        <option value={AUTO}>Max for size (up to {AUTO_MAX_FPS} fps)</option>
        {#each RATES as r, i}<option value={String(i)}>{r.label}</option>{/each}
        <option value={CUSTOM}>Custom…</option>
      </select>
      {#if rateChoice === CUSTOM}
        <input
          class="fps"
          type="text"
          inputmode="decimal"
          aria-label="Frame rate (custom)"
          bind:value={fpsDraft}
          onchange={commitFps}
          onkeydown={(e) => e.key === 'Enter' && commitFps()}
        />
        <span class="muted">fps</span>
      {/if}
    </span>

    <span class="label">Dithering</span>
    <span class="row">
      <select bind:value={app.settings.dither} aria-label="Dithering">
        {#each DITHERS as d}<option value={d.id}>{d.label}</option>{/each}
      </select>
      {#if s.dither === 'bayer'}
        <select bind:value={app.settings.bayerScale} aria-label="Bayer scale">
          {#each [0, 1, 2, 3, 4, 5] as n}<option value={n}>Scale {n}{n === 0 ? ' (strongest)' : n === 5 ? ' (subtlest)' : ''}</option>{/each}
        </select>
      {/if}
    </span>
  </div>

  <div class="notes muted">
    {#if sourceHeight && s.height > sourceHeight}
      <p class="warn">Larger than the source ({sourceHeight}p), so the video will be upscaled.</p>
    {/if}
    {#if s.height < calLow || s.height > calHigh}
      <p>Size estimates were calibrated at {calLow}–{calHigh}p; at {s.height}p they're extrapolated and less certain.</p>
    {/if}
    {#if s.fpsMode === 'manual' && s.manualFps > 50}
      <p>Browsers play GIFs faster than 50 fps more slowly, so 50 is the maximum.</p>
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
    gap: 0.55rem 0.7rem;
    align-items: center;
  }
  .label {
    font-size: 0.88rem;
    color: var(--muted);
  }
  .dims {
    font-size: 0.82rem;
    font-variant-numeric: tabular-nums;
  }
  .fps {
    width: calc(7ch + 1.2rem);
    font-variant-numeric: tabular-nums;
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
