<script lang="ts">
  import type { FontId } from '../lib/fonts';
  import { addUserFont, app } from '../state.svelte';

  let { value = $bindable(), label = 'Font' }: { value: FontId; label?: string } = $props();
  let picker: HTMLInputElement | undefined = $state();

  const ADD = '__add';
  const groups = $derived(
    ([['bundled', 'Included'], ['embedded', 'In this video'], ['added', 'Added']] as const)
      .map(([source, name]) => ({ name, fonts: app.fontChoices.filter((f) => f.source === source) }))
      .filter((g) => g.fonts.length),
  );

  function change(e: Event & { currentTarget: HTMLSelectElement }) {
    const v = e.currentTarget.value;
    if (v === ADD) {
      e.currentTarget.value = value;
      picker?.click();
    } else value = v;
  }

  async function picked(e: Event & { currentTarget: HTMLInputElement }) {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file) return;
    const id = await addUserFont(file);
    if (id) value = id;
  }
</script>

<select {value} onchange={change} aria-label={label}>
  {#each groups as g}
    <optgroup label={g.name}>
      {#each g.fonts as f}<option value={f.id}>{f.label}</option>{/each}
    </optgroup>
  {/each}
  <option value={ADD}>Add a font file…</option>
</select>
<input bind:this={picker} type="file" accept=".ttf,.otf,.ttc" hidden onchange={picked} />
