<script lang="ts">
  /** A free-entry number field: any value in [min, max], committed on Enter or blur. */
  let {
    value = $bindable(),
    min = -Infinity,
    max = Infinity,
    integer = false,
    label,
    suffix = '',
    size = 5,
  }: {
    value: number;
    min?: number;
    max?: number;
    integer?: boolean;
    label: string;
    suffix?: string;
    /** Width in digits. */
    size?: number;
  } = $props();

  let draft = $state('');
  $effect(() => {
    draft = format(value);
  });

  function format(v: number): string {
    return Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : '';
  }

  function commit() {
    let v = parseFloat(draft);
    if (!Number.isFinite(v)) {
      draft = format(value);
      return;
    }
    v = Math.min(max, Math.max(min, v));
    if (integer) v = Math.round(v);
    value = v;
    draft = format(v);
  }
</script>

<span class="number-field">
  <input
    type="text"
    inputmode="decimal"
    style:width="calc({size}ch + 1.2rem)"
    aria-label={label}
    bind:value={draft}
    onchange={commit}
    onkeydown={(e) => e.key === 'Enter' && commit()}
  />
  {#if suffix}<span class="suffix">{suffix}</span>{/if}
</span>

<style>
  .number-field {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
  }
  input {
    font-variant-numeric: tabular-nums;
  }
  .suffix {
    color: var(--muted);
    font-size: 0.85rem;
  }
</style>
