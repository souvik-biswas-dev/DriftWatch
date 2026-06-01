<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { setToken } from '$lib/api';
	import Logo from '$lib/Logo.svelte';

	// The backend redirects here as /auth/callback#token=<jwt>. The fragment is
	// never sent to a server, so the token isn't logged in transit. We read it,
	// persist it, and replace history so Back doesn't return to this page.
	onMount(() => {
		const hash = window.location.hash.startsWith('#')
			? window.location.hash.slice(1)
			: window.location.hash;
		const token = new URLSearchParams(hash).get('token');

		if (token) {
			setToken(token);
			goto('/dashboard', { replaceState: true });
		} else {
			goto('/login?error=missing_token', { replaceState: true });
		}
	});
</script>

<svelte:head>
	<title>Signing in… — DriftWatch</title>
</svelte:head>

<div class="flex min-h-screen flex-col items-center justify-center gap-6 bg-[#0a0a0a]">
	<Logo size={40} showWord={false} />
	<p class="font-mono text-sm text-neutral-500">Signing you in…</p>
</div>
