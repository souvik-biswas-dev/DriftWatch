<script lang="ts">
	import { onMount } from 'svelte';
	import { fade } from 'svelte/transition';
	import { goto } from '$app/navigation';
	import { toast } from 'svelte-sonner';

	import { api, setToken, ApiClientError } from '$lib/api';
	import Logo from '$lib/Logo.svelte';

	let mode: 'login' | 'register' = 'login';
	let email = '';
	let password = '';
	let loading = false;

	onMount(() => {
		// If already signed in, skip the form.
		if (typeof localStorage !== 'undefined' && localStorage.getItem('driftwatch_token')) {
			goto('/dashboard');
		}
	});

	async function submit() {
		if (!email || !password) {
			toast.error('Email and password are required');
			return;
		}
		if (mode === 'register' && password.length < 8) {
			toast.error('Password must be at least 8 characters');
			return;
		}

		loading = true;
		try {
			if (mode === 'register') {
				await api.register(email, password);
			}
			const res = await api.login(email, password);
			setToken(res.token);
			toast.success(mode === 'register' ? 'Account created' : 'Signed in');
			goto('/dashboard');
		} catch (e) {
			const msg = e instanceof ApiClientError ? e.message : 'authentication failed';
			toast.error(msg);
		} finally {
			loading = false;
		}
	}

	function toggleMode() {
		mode = mode === 'login' ? 'register' : 'login';
	}
</script>

<svelte:head>
	<title>{mode === 'login' ? 'Sign In' : 'Sign Up'} — DriftWatch</title>
</svelte:head>

<div class="flex min-h-screen items-center justify-center bg-[#0a0a0a] px-6 py-12">
	<div class="w-full max-w-sm" in:fade={{ duration: 200 }}>
		<a href="/" class="mb-10 flex justify-center transition-opacity hover:opacity-80">
			<Logo size={32} wordClass="text-2xl" />
		</a>

		<div class="rounded-lg border border-neutral-800 bg-[#0f0f0f] p-7">
			<h1 class="mb-1 font-mono text-xl font-semibold text-white">
				{mode === 'login' ? 'Sign in' : 'Create account'}
			</h1>
			<p class="mb-6 font-mono text-xs text-neutral-500">
				{mode === 'login'
					? 'Welcome back. Use your email to continue.'
					: 'Start monitoring drift across your Docker hosts.'}
			</p>

			<form on:submit|preventDefault={submit} class="space-y-4">
				<div>
					<label for="login-email" class="mb-1.5 block font-mono text-xs uppercase tracking-widest text-neutral-400">
						Email
					</label>
					<input
						id="login-email"
						type="email"
						autocomplete="email"
						bind:value={email}
						required
						class="w-full rounded-md border border-neutral-800 bg-[#0a0a0a] px-3 py-2 font-mono text-sm text-white placeholder-neutral-600 focus:border-[#00ff88] focus:outline-none focus:ring-1 focus:ring-[#00ff88]/50"
						placeholder="you@example.com"
					/>
				</div>

				<div>
					<label for="login-password" class="mb-1.5 block font-mono text-xs uppercase tracking-widest text-neutral-400">
						Password
					</label>
					<input
						id="login-password"
						type="password"
						autocomplete={mode === 'login' ? 'current-password' : 'new-password'}
						bind:value={password}
						required
						minlength={mode === 'register' ? 8 : undefined}
						class="w-full rounded-md border border-neutral-800 bg-[#0a0a0a] px-3 py-2 font-mono text-sm text-white placeholder-neutral-600 focus:border-[#00ff88] focus:outline-none focus:ring-1 focus:ring-[#00ff88]/50"
						placeholder="••••••••"
					/>
					{#if mode === 'register'}
						<p class="mt-1.5 font-mono text-xs text-neutral-600">Minimum 8 characters.</p>
					{/if}
				</div>

				<button
					type="submit"
					disabled={loading}
					class="w-full rounded-md py-2.5 font-mono text-sm font-semibold transition-all hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100"
					style="background: var(--accent); color: #0a0a0a;"
				>
					{loading ? '…' : mode === 'login' ? 'Sign in' : 'Create account'}
				</button>
			</form>

			<div class="mt-6 text-center font-mono text-xs text-neutral-500">
				{mode === 'login' ? "Don't have an account?" : 'Already have an account?'}
				<button
					type="button"
					on:click={toggleMode}
					class="ml-1 text-neutral-300 transition-colors hover:text-[#00ff88]"
				>
					{mode === 'login' ? 'Sign up' : 'Sign in'}
				</button>
			</div>
		</div>

		<a href="/" class="mt-6 block text-center font-mono text-xs text-neutral-600 hover:text-neutral-400">
			← Back to home
		</a>
	</div>
</div>
