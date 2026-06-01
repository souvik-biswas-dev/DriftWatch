<script lang="ts">
	import { onMount } from 'svelte';
	import { fade } from 'svelte/transition';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { toast } from 'svelte-sonner';

	import { API_BASE } from '$lib/api';
	import Logo from '$lib/Logo.svelte';

	onMount(() => {
		// Already signed in → skip straight to the dashboard.
		if (typeof localStorage !== 'undefined' && localStorage.getItem('driftwatch_token')) {
			goto('/dashboard', { replaceState: true });
			return;
		}
		// Surface an OAuth error bounced back from the backend (?error=...).
		const err = $page.url.searchParams.get('error');
		if (err) toast.error(`GitHub sign-in failed: ${err.replace(/_/g, ' ')}`);
	});

	function signInWithGitHub() {
		// Full-page redirect to the backend, which forwards to GitHub's consent
		// screen and ultimately returns to /auth/callback with a session token.
		window.location.href = `${API_BASE}/api/auth/github/login`;
	}
</script>

<svelte:head>
	<title>Sign In — DriftWatch</title>
</svelte:head>

<div class="flex min-h-screen items-center justify-center bg-[#0a0a0a] px-6 py-12">
	<div class="w-full max-w-sm" in:fade={{ duration: 200 }}>
		<a href="/" class="mb-10 flex justify-center transition-opacity hover:opacity-80">
			<Logo size={32} wordClass="text-2xl" />
		</a>

		<div class="rounded-lg border border-neutral-800 bg-[#0f0f0f] p-7">
			<h1 class="mb-1 font-mono text-xl font-semibold text-white">Sign in</h1>
			<p class="mb-6 font-mono text-xs text-neutral-500">
				Continue with GitHub to start monitoring drift across your Docker hosts.
			</p>

			<button
				type="button"
				on:click={signInWithGitHub}
				class="flex w-full items-center justify-center gap-2.5 rounded-md bg-white py-2.5 font-mono text-sm font-semibold text-[#0a0a0a] transition-all hover:scale-[1.02]"
			>
				<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
					<path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.5 11.5 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222 0 1.606-.014 2.898-.014 3.293 0 .322.216.694.825.576C20.565 22.092 24 17.595 24 12.297c0-6.627-5.373-12-12-12" />
				</svg>
				Continue with GitHub
			</button>

			<p class="mt-5 font-mono text-[11px] leading-relaxed text-neutral-600">
				DriftWatch requests <span class="text-neutral-400">repo</span> access so it can read
				your <span class="text-neutral-400">docker-compose.yml</span> (including private repos).
				Your token is encrypted at rest and never shared.
			</p>
		</div>

		<a href="/" class="mt-6 block text-center font-mono text-xs text-neutral-600 hover:text-neutral-400">
			← Back to home
		</a>
	</div>
</div>
