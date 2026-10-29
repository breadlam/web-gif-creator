<script lang="ts">
  import { describeAudio, describeTrack, describeVideo } from '../lib/probe';
  import { app, loadSubtitles, selectTrack, selectVideoTrack } from '../state.svelte';

  const info = $derived(app.info!);
  const current = $derived(info.videos.find((v) => v.index === info.videoIndex));

  function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
  }

  function lineCount(index: number): number {
    return (app.subtitleTracks[index]?.match(/^\s*Dialogue:/gim) ?? []).length;
  }
</script>

<div class="card">
  <h2>Tracks</h2>
  <div class="grid">
    <span class="label">Video</span>
    {#if info.videos.length > 1}
      <select
        value={info.videoIndex}
        disabled={!!app.busy}
        onchange={(e) => selectVideoTrack(Number(e.currentTarget.value))}
        aria-label="Video track"
      >
        {#each info.videos as v}<option value={v.index}>#{v.index} {describeVideo(v)}</option>{/each}
      </select>
    {:else}
      <span class="value">{current ? describeVideo(current) : ''}</span>
    {/if}

    <span class="label">Audio</span>
    {#if info.audio.length === 0}
      <span class="value muted">None in this file</span>
    {:else}
      <select
        value={app.audioTrack ?? ''}
        onchange={(e) => (app.audioTrack = e.currentTarget.value === '' ? null : Number(e.currentTarget.value))}
        aria-label="Audio track"
      >
        <option value="">Off</option>
        {#each info.audio as a}<option value={a.index}>#{a.index} {describeAudio(a)}</option>{/each}
      </select>
    {/if}

    <span class="label">Subtitles</span>
    {#if info.subtitles.length === 0}
      <span class="value muted">None in this file</span>
    {:else if app.subtitleStatus === 'loading'}
      <span class="value muted">Reading subtitles…</span>
    {:else if app.subtitleStatus === 'failed'}
      <span class="value warn">Not read <button class="small" onclick={loadSubtitles} disabled={!!app.busy}>Read</button></span>
    {:else}
      <select
        value={app.track ?? ''}
        onchange={(e) => selectTrack(e.currentTarget.value === '' ? null : Number(e.currentTarget.value))}
        aria-label="Subtitle track"
      >
        <option value="">None</option>
        {#each info.subtitles as t}
          <option value={t.index} disabled={!(t.index in app.subtitleTracks)}>
            #{t.index} {describeTrack(t)} · {t.text ? plural(lineCount(t.index), 'line') : 'image subtitles, not supported yet'}
          </option>
        {/each}
      </select>
    {/if}
  </div>
  <p class="muted note">The audio track is only for listening while you trim; GIFs have no sound.</p>
</div>

<style>
  .grid {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 0.45rem 0.7rem;
    align-items: center;
  }
  .label {
    font-size: 0.88rem;
    color: var(--muted);
  }
  .value {
    font-size: 0.88rem;
    overflow-wrap: anywhere;
  }
  select {
    width: 100%;
    min-width: 0;
  }
  .warn {
    color: var(--warn);
  }
  .note {
    font-size: 0.8rem;
    margin: 0.5rem 0 0;
  }
</style>
