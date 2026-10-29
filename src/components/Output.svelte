<script lang="ts">
  import { MODEL } from '../lib/sizeModel';
  import { app, calculate, encode, planKey, retryFps } from '../state.svelte';

  const fresh = $derived(app.plan !== null && app.planKey === planKey());
  const plan = $derived(app.plan);
  const over = $derived(app.output && app.output.bytes > app.output.budget);

  function mb(bytes: number): string {
    return `${(bytes / 1e6).toFixed(bytes < 1e7 ? 2 : 1)} MB`;
  }

  const LIMIT: Record<string, string> = {
    budget: 'limited by the size budget',
    source: 'limited by the source frame rate',
    gif: 'limited by GIF playback (50 fps max)',
    manual: 'fixed frame rate',
  };
</script>

<div class="card">
  <h2>Frame rate &amp; size</h2>
  <div class="row">
    <button onclick={calculate} disabled={!!app.busy || !app.input}>Calculate</button>
    <button class="primary" onclick={() => encode()} disabled={!!app.busy || !app.input}>Make GIF</button>
  </div>

  {#if plan}
    <dl class:stale={!fresh}>
      <dt>Frame rate</dt>
      <dd class="mono">
        <strong>{plan.fps.toFixed(2)} fps</strong>
        {#if plan.delayCs}<span class="muted">({plan.delayCs} cs per frame)</span>{/if}
      </dd>
      <dt></dt>
      <dd class="muted small">{LIMIT[plan.limitedBy]}</dd>
      <dt>Frames</dt>
      <dd class="mono">{plan.frames} at {plan.width}×{plan.height}</dd>
      <dt>Expected size</dt>
      <dd class="mono">{mb(plan.expectedBytes)}</dd>
      <dt>Planned for</dt>
      <dd class="mono">{mb(plan.safeBytes)} <span class="muted">of {mb(plan.budget)}</span></dd>
    </dl>
    <details class="muted small">
      <summary>How this was calculated</summary>
      <p>
        One ffmpeg pass measured how much of each frame changes from the previous one
        ({Object.entries(plan.features).map(([k, v]) => `${k} = ${v.toFixed(3)}`).join(', ')}, at {plan.analysedAt.toFixed(1)} fps).
        The size model (fitted on {MODEL.clips} clips with FFmpeg {MODEL.ffmpeg}) turns that into
        {plan.k.expected.toFixed(3)} bytes per pixel per frame. It plans for {plan.k.safe.toFixed(3)} to leave a
        safety margin.
      </p>
    </details>
    {#if !fresh}<p class="warn small">Settings changed since this was calculated; it will be recalculated.</p>{/if}
  {/if}

  {#if app.output}
    {@const o = app.output}
    <div class="result">
      <img src={o.url} alt="Generated GIF" />
      <div class="row">
        <strong class="mono" class:bad={over} class:good={!over}>{mb(o.bytes)}</strong>
        <span class="muted mono">{o.frames} frames · {o.fps.toFixed(2)} fps</span>
        {#if o.expectedBytes}
          <span class="muted mono small">estimate was {mb(o.expectedBytes)} ({o.bytes > o.expectedBytes ? '+' : ''}{(((o.bytes - o.expectedBytes) / o.expectedBytes) * 100).toFixed(0)}%)</span>
        {/if}
      </div>
      {#if over}
        <p class="warn small">
          This GIF is {(((o.bytes - o.budget) / o.budget) * 100).toFixed(1)}% over the limit.
          <button class="small" onclick={() => encode(retryFps(o))} disabled={!!app.busy}>
            Re-encode at {retryFps(o).toFixed(2)} fps
          </button>
        </p>
      {/if}
      <a class="download" href={o.url} download={o.name}>Download {o.name}</a>
    </div>
  {/if}
</div>

<style>
  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.2rem 0.8rem;
    margin: 0.8rem 0 0.4rem;
  }
  dl.stale {
    opacity: 0.55;
  }
  dt {
    color: var(--muted);
    font-size: 0.88rem;
  }
  dd {
    margin: 0;
  }
  .small {
    font-size: 0.82rem;
  }
  .warn {
    color: var(--warn);
  }
  details p {
    margin: 0.4rem 0 0;
  }
  .result {
    display: grid;
    gap: 0.5rem;
    margin-top: 0.8rem;
    padding-top: 0.8rem;
    border-top: 1px solid var(--border);
  }
  .result img {
    max-width: 100%;
    border-radius: 4px;
  }
  .good {
    color: var(--ok);
  }
  .bad {
    color: var(--danger);
  }
  .download {
    color: var(--accent);
    font-weight: 600;
    word-break: break-all;
  }
</style>
