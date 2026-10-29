<script lang="ts">
  /**
   * A number input that accepts any value in [min, max], with optional presets as a
   * shortcut. Presets use a plain <select> (Firefox shows no datalist on number inputs).
   */
  interface Preset {
    value: number;
    label?: string;
  }

  let {
    value = $bindable(),
    min = -Infinity,
    max = Infinity,
    integer = false,
    even = false,
    presets = [],
    label,
    suffix = '',
    size = 6,
    onchange,
  }: {
    value: number;
    min?: number;
    max?: number;
    integer?: boolean;
    /** Round to an even number (video dimensions). */
    even?: boolean;
    presets?: Preset[];
    label: string;
    suffix?: string;
    size?: number;
    onchange?: (v: number) => void;
  } = $props();

  let draft = $state('');
  $effect(() => {
    draft = format(value);
  });

  function format(v: number): string {
    return Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : '';
  }

  function commit(raw: string) {
    let v = parseFloat(raw);
    if (!Number.isFinite(v)) {
      draft = format(value);
      return;
    }
    v = Math.min(max, Math.max(min, v));
    if (integer) v = Math.round(v);
    if (even) v = Math.max(2, Math.round(v / 2) * 2);
    value = v;
    draft = format(v);
    onchange?.(v);
  }
</script>

<span class="number-field">
  <input
    type="number"
    step="any"
    inputmode="decimal"
    {min}
    {max}
    style:width="{size + 1.5}ch"
    aria-label={label}
    bind:value={draft}
    onchange={(e) => commit(e.currentTarget.value)}
    onkeydown={(e) => e.key === 'Enter' && commit(e.currentTarget.value)}
  />
  {#if suffix}<span class="suffix">{suffix}</span>{/if}
  {#if presets.length}
    <select
      aria-label="{label} presets"
      value=""
      onchange={(e) => {
        const v = e.currentTarget.value;
        e.currentTarget.value = '';
        if (v !== '') commit(v);
      }}
    >
      <option value="" disabled>Presets</option>
      {#each presets as p}<option value={p.value}>{p.label ?? p.value}</option>{/each}
    </select>
  {/if}
</span>

<style>
  .number-field {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }
  .suffix {
    color: var(--muted);
    font-size: 0.85rem;
  }
  select {
    max-width: 7rem;
  }
</style>
