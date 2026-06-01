<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { browser } from '$app/environment';

	let ready = false;

	onMount(() => {
		if (browser) {
			const token = localStorage.getItem('driftwatch_token');
			if (!token) {
				// replaceState so /dashboard doesn't linger in history — otherwise
				// pressing Back from /login lands on /dashboard, which bounces
				// straight back to /login (a redirect trap).
				goto('/login', { replaceState: true });
				return;
			}
		}
		ready = true;
	});
</script>

{#if ready}
	<slot />
{/if}
