<script lang="ts">
  import type { Cue } from '../lib/ass';
  import { FONTS } from '../lib/fonts';
  import { cueText, DEFAULT_SUBTITLE_STYLE, nearby, overlapping, searchCues } from '../lib/subtitles';
  import { formatTime } from '../lib/time';
  import { app, clipToCue, controls, extendToCue, setCueText } from '../state.svelte';

  const inClip = $derived(overlapping(app.cues, app.start, app.end));

  let query = $state('');
  const browse = $derived(query.trim() ? searchCues(app.cues, query) : nearby(app.cues, app.current));
  let editing: number | null = $state(null);

  function toggle(cue: Cue, on: boolean) {
    app.disabledCues = on ? app.disabledCues.filter((l) => l !== cue.line) : [...app.disabledCues, cue.line];
  }
</script>

{#if app.track !== null}
  <div class="card">
    <h2>Subtitles</h2>
        <div class="modes" role="radiogroup" aria-label="Include subtitles in the GIF">
          {#each [['off', 'Leave out'], ['original', 'Original styling'], ['custom', 'My style']] as [value, label]}
            <label class:on={app.subMode === value}>
              <input type="radio" name="submode" {value} bind:group={app.subMode} />
              {label}
            </label>
          {/each}
        </div>

        {#if app.subMode === 'custom'}
          <div class="row style">
            <select bind:value={app.settings.subtitleStyle.font} aria-label="Subtitle font">
              {#each FONTS as f}<option value={f.id}>{f.label}</option>{/each}
            </select>
            <input type="color" bind:value={app.settings.subtitleStyle.color} aria-label="Subtitle colour" />
            <input type="color" bind:value={app.settings.subtitleStyle.outlineColor} aria-label="Subtitle outline colour" />
            <label class="row mini">Size <input type="range" min="3" max="20" step="0.5" bind:value={app.settings.subtitleStyle.size} /></label>
            <label class="row mini">Outline <input type="range" min="0" max="2" step="0.1" bind:value={app.settings.subtitleStyle.outline} /></label>
          </div>
          <p class="muted note">
            Drag the subtitle on the video to move it.
            <button class="small" onclick={() => ((app.settings.subtitleStyle.x = DEFAULT_SUBTITLE_STYLE.x), (app.settings.subtitleStyle.y = DEFAULT_SUBTITLE_STYLE.y))}>Reset position</button>
          </p>
        {:else if app.subMode === 'original'}
          <p class="muted note">Burned in with the track's own fonts and positions. The video preview is approximate; use "Preview exact frame" to check.</p>
        {/if}

        <h3>In the clip <span class="muted">({inClip.length})</span></h3>
        {#if inClip.length === 0}
          <p class="muted note">No lines in the selected range. Find one below and press Clip.</p>
        {:else}
          <ul>
            {#each inClip as cue (cue.line)}
              <li class:off={app.disabledCues.includes(cue.line) || app.subMode === 'off'}>
                <input
                  type="checkbox"
                  checked={!app.disabledCues.includes(cue.line)}
                  disabled={app.subMode === 'off'}
                  onchange={(e) => toggle(cue, e.currentTarget.checked)}
                  aria-label="Include this line"
                />
                <button class="link mono" onclick={() => controls.seek(cue.start)}>{formatTime(cue.start, 2)}</button>
                {#if editing === cue.line}
                  <!-- svelte-ignore a11y_autofocus -->
                  <textarea
                    rows="2"
                    autofocus
                    value={cueText(cue, app.cueOverrides)}
                    onblur={(e) => {
                      setCueText(cue, e.currentTarget.value);
                      editing = null;
                    }}
                    onkeydown={(e) => e.key === 'Escape' && (editing = null)}
                  ></textarea>
                {:else}
                  <button class="cue" title="Click to edit this line" onclick={() => (editing = cue.line)}>
                    {cueText(cue, app.cueOverrides)}{#if cue.line in app.cueOverrides}<span class="edited"> (edited)</span>{/if}
                  </button>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}

        <h3>Find a line</h3>
        <input type="search" placeholder="Search {app.cues.length} lines…" bind:value={query} />
        {#if !query.trim()}<p class="muted note">Lines near the playhead:</p>{/if}
        <ul class="browse">
          {#each browse as cue (cue.line)}
            <li>
              <button class="link mono" onclick={() => controls.seek(cue.start)}>{formatTime(cue.start, 2)}</button>
              <span class="text">{cue.text}</span>
              <span class="actions">
                <button class="small" onclick={() => clipToCue(cue)} title="Set the clip to this line">Clip</button>
                <button class="small" onclick={() => extendToCue(cue)} title="Extend the clip to include this line">Extend</button>
              </span>
            </li>
          {:else}
            <li class="muted note">No matches.</li>
          {/each}
        </ul>
    {#if app.embeddedFonts}
      <p class="muted note">{app.embeddedFonts} embedded font{app.embeddedFonts === 1 ? '' : 's'} loaded.</p>
    {/if}
  </div>
{/if}

<style>
  select,
  input[type='search'] {
    width: 100%;
  }
  h3 {
    font-size: 0.85rem;
    margin: 0.9rem 0 0.3rem;
  }
  .note {
    font-size: 0.82rem;
    margin: 0.4rem 0 0;
  }
  .modes {
    display: flex;
    margin-top: 0.6rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }
  .modes label {
    flex: 1;
    text-align: center;
    font-size: 0.85rem;
    padding: 0.3rem 0.2rem;
    cursor: pointer;
    border-left: 1px solid var(--border);
  }
  .modes label:first-child {
    border-left: none;
  }
  .modes label.on {
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
  }
  .modes input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }
  .style {
    margin-top: 0.6rem;
  }
  .mini {
    gap: 0.3rem;
    font-size: 0.82rem;
    color: var(--muted);
  }
  .mini input[type='range'] {
    width: 70px;
  }
  ul {
    list-style: none;
    padding: 0;
    margin: 0.3rem 0 0;
    display: grid;
    gap: 0.3rem;
    max-height: 240px;
    overflow: auto;
  }
  li {
    display: grid;
    grid-template-columns: auto auto 1fr;
    gap: 0.4rem;
    align-items: start;
    font-size: 0.86rem;
  }
  li.off .cue {
    opacity: 0.5;
    text-decoration: line-through;
  }
  .browse li {
    grid-template-columns: auto 1fr auto;
  }
  .cue {
    border: none;
    background: none;
    padding: 0;
    text-align: left;
    white-space: pre-line;
    cursor: text;
  }
  .edited {
    color: var(--accent);
    font-size: 0.78rem;
  }
  .text {
    white-space: pre-line;
  }
  .actions {
    display: flex;
    gap: 0.25rem;
  }
  textarea {
    width: 100%;
  }
  .link {
    border: none;
    background: none;
    padding: 0;
    color: var(--accent);
    font-size: 0.8rem;
  }
</style>
