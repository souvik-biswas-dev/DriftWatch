<script lang="ts">
	// DriftWatch brand mark: a radar that "watches" the declared state (centre
	// rings + node) and a bright node that has "drifted" off to the side,
	// connected by the drift vector. Theme: dark bg, #00ff88 accent, mono wordmark.
	export let size = 28;
	export let showWord = true;
	/** Tailwind text-size class for the wordmark, e.g. "text-xl". */
	export let wordClass = 'text-xl';
</script>

<span class="inline-flex items-center gap-2.5">
	<svg
		width={size}
		height={size}
		viewBox="0 0 32 32"
		fill="none"
		xmlns="http://www.w3.org/2000/svg"
		aria-hidden="true"
		class="shrink-0"
	>
		<circle cx="13" cy="16" r="9" stroke="#00ff88" stroke-opacity="0.25" stroke-width="1.5" />
		<circle cx="13" cy="16" r="5.5" stroke="#00ff88" stroke-opacity="0.45" stroke-width="1.5" />
		<circle cx="13" cy="16" r="2.2" fill="#00ff88" />
		<line x1="13" y1="16" x2="24" y2="9" stroke="#00ff88" stroke-width="1.6" stroke-linecap="round" />
		<circle cx="24" cy="9" r="2.8" fill="#00ff88" />
		<circle cx="24" cy="9" r="2.8" fill="#00ff88" opacity="0.35" />
	</svg>
	{#if showWord}
		<span class="font-mono {wordClass} font-bold tracking-tight">
			<span class="text-white">Drift</span><span style="color: var(--accent)">Watch</span>
		</span>
	{/if}
</span>
