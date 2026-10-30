<script lang="ts">
  /**
   * A dropdown of presets with a "Custom…" entry that reveals an input for any value
   * in [min, max].
   */
  interface Preset {
    value: number;
    label: string;
  }

  let {
    value = $bindable(),
    presets,
    min = -Infinity,
    max = Infinity,
    integer = false,
    even = false,
    label,
    suffix = '',
  }: {
    value: number;
    presets: Preset[];
    min?: number;
    max?: number;
    integer?: boolean;
    /** Round to an even number (video dimensions). */
    even?: boolean;
    label: string;
    suffix?: string;
  } = $props();

  const CUSTOM = 'custom';
  const matches = (v: number) => presets.findIndex((p) => Math.abs(p.value - v) < 1e-6);
  // Custom stays selected while the user is editing, even if they type a preset's value.
  let custom = $state(false);
  $effect.pre(() => {
    if (matches(value) < 0) custom = true;
  });
  const selected = $derived(custom ? CUSTOM : String(matches(value)));

  let input: HTMLInputElement | undefined = $state();
  let draft = $state('');
  $effect(() => {
    draft = format(value);
  });

  function format(v: number): string {
    return Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : '';
  }

  function pick(e: Event & { currentTarget: HTMLSelectElement }) {
    const v = e.currentTarget.value;
    if (v === CUSTOM) {
      custom = true;
      queueMicrotask(() => input?.select());
    } else {
      custom = false;
      value = presets[Number(v)].value;
    }
  }

  function commit() {
    let v = parseFloat(draft);
    if (!Number.isFinite(v)) {
      draft = format(value);
      return;
    }
    v = Math.min(max, Math.max(min, v));
    if (integer) v = Math.round(v);
    if (even) v = Math.max(2, Math.round(v / 2) * 2);
    value = v;
    draft = format(v);
  }
</script>

<span class="preset-select">
  <select value={selected} onchange={pick} aria-label={label}>
    {#each presets as p, i}<option value={String(i)}>{p.label}</option>{/each}
    <option value={CUSTOM}>Custom…</option>
  </select>
  {#if custom}
    <input
      bind:this={input}
      type="text"
      inputmode="decimal"
      aria-label="{label} (custom)"
      bind:value={draft}
      onchange={commit}
      onkeydown={(e) => e.key === 'Enter' && commit()}
    />
    {#if suffix}<span class="suffix">{suffix}</span>{/if}
  {/if}
</span>

<style>
  .preset-select {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    flex-wrap: wrap;
  }
  input {
    width: calc(7ch + 1.2rem);
    font-variant-numeric: tabular-nums;
  }
  .suffix {
    color: var(--muted);
    font-size: 0.85rem;
  }
</style>
