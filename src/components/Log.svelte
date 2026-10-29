<script lang="ts">
  import { app } from '../state.svelte';
</script>

<details class="log">
  <summary class="muted">ffmpeg log ({app.log.length} lines)</summary>
  <pre>{app.log.slice(-200).join('\n')}</pre>
</details>

<style>
  .log {
    margin: 0 1.2rem 1.2rem;
    font-size: 0.8rem;
  }
  pre {
    max-height: 280px;
    overflow: auto;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.6rem;
    white-space: pre-wrap;
  }
</style>
