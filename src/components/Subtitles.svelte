<script lang="ts">
  import { describeTrack } from '../lib/probe';
  import { formatTime } from '../lib/time';
  import { app, controls, cueToOverlay, selectTrack } from '../state.svelte';

  const tracks = $derived(app.info?.subtitles ?? []);
  const inRange = $derived(app.cues.filter((c) => c.end > app.start && c.start < app.end));

  function toggle(line: number, on: boolean) {
    app.disabledCues = on ? app.disabledCues.filter((l) => l !== line) : [...app.disabledCues, line];
  }
</script>

{#if tracks.length}
  <div class="card">
    <h2>Subtitles</h2>
    <select
      value={app.track ?? ''}
      disabled={!!app.busy}
      onchange={(e) => {
        const v = e.currentTarget.value;
        selectTrack(v === '' ? null : Number(v));
      }}
    >
      <option value="">Don't burn in subtitles</option>
      {#each tracks as t}
        <option value={t.index} disabled={!t.text}>{describeTrack(t)}{t.text ? '' : ' (image subtitles not supported yet)'}</option>
      {/each}
    </select>
    {#if app.embeddedFonts}
      <p class="muted note">{app.embeddedFonts} embedded font{app.embeddedFonts === 1 ? '' : 's'} loaded for styled subtitles.</p>
    {/if}
    {#if app.subtitleAss}
      {#if inRange.length}
        <ul>
          {#each inRange as cue (cue.line)}
            <li>
              <input
                type="checkbox"
                checked={!app.disabledCues.includes(cue.line)}
                onchange={(e) => toggle(cue.line, e.currentTarget.checked)}
                aria-label="Burn in this line"
              />
              <button class="link mono" onclick={() => controls.seek(cue.start)}>{formatTime(cue.start, 2)}</button>
              <span class="cue">{cue.text}</span>
              <button class="small" onclick={() => cueToOverlay(cue)} title="Edit and position this line yourself">Edit</button>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="muted note">No subtitle lines in the selected range.</p>
      {/if}
    {/if}
  </div>
{/if}

<style>
  select {
    width: 100%;
  }
  .note {
    font-size: 0.82rem;
    margin: 0.4rem 0 0;
  }
  ul {
    list-style: none;
    padding: 0;
    margin: 0.6rem 0 0;
    display: grid;
    gap: 0.35rem;
    max-height: 260px;
    overflow: auto;
  }
  li {
    display: grid;
    grid-template-columns: auto auto 1fr auto;
    gap: 0.4rem;
    align-items: start;
    font-size: 0.88rem;
  }
  .cue {
    white-space: pre-line;
  }
  .link {
    border: none;
    background: none;
    padding: 0;
    color: var(--accent);
    font-size: 0.82rem;
  }
</style>
