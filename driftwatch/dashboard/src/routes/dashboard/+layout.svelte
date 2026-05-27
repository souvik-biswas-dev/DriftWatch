<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { browser } from '$app/environment';

	let ready = false;

	onMount(() => {
		if (browser) {
			const token = localStorage.getItem('driftwatch_token');
			if (!token) {
				goto('/login');
				return;
			}
		}
		ready = true;
	});
</script>

{#if ready}
	<slot />
{/if}
