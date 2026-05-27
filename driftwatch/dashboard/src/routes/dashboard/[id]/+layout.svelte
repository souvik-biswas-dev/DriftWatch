<script lang="ts">
	import { onMount } from 'svelte';
	import { fade } from 'svelte/transition';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { toast } from 'svelte-sonner';

	import { api, ApiClientError } from '$lib/api';
	import { timeAgo } from '$lib/utils';
	import type { Project, Snapshot, DriftEvent } from '$lib/types';

	let project: Project | null = null;
	let snapshot: Snapshot | null = null;
	let drifts: DriftEvent[] = [];
	let loading = true;

	$: projectId = $page.params.id;

	async function load() {
		loading = true;
		try {
			const [detail, ds] = await Promise.all([api.getProject(projectId), api.listDrifts(projectId)]);
			project = detail.project;
			snapshot = detail.latest_snapshot;
			drifts = ds ?? [];
		} catch (e) {
			const msg = e instanceof ApiClientError ? e.message : 'failed to load project';
			toast.error(msg);
			project = null;
			drifts = [];
		} finally {
			loading = false;
		}
	}

	async function handleDelete() {
		if (!project) return;
		if (!confirm(`Delete project "${project.name}"? This cannot be undone.`)) return;
		try {
			await api.deleteProject(project.id);
			toast.success('Project deleted');
			goto('/dashboard');
		} catch (e) {
			const msg = e instanceof ApiClientError ? e.message : 'failed to delete project';
			toast.error(msg);
		}
	}

	$: driftsToday = drifts.filter((d) => {
		const created = new Date(d.created_at).getTime();
		return Date.now() - created < 24 * 60 * 60 * 1000;
	}).length;

	$: criticalToday = drifts.filter((d) => {
		const created = new Date(d.created_at).getTime();
		return Date.now() - created < 24 * 60 * 60 * 1000 && d.severity === 'critical';
	}).length;

	onMount(load);
</script>

<div class="flex min-h-screen bg-[#0a0a0a]">
	<!-- Sidebar -->
	<aside class="hidden w-72 shrink-0 flex-col border-r border-neutral-900 bg-[#0c0c0c] md:flex">
		<div class="border-b border-neutral-900 px-6 py-5">
			<button
				type="button"
				on:click={() => goto('/dashboard')}
				class="mb-5 flex items-center gap-2 font-mono text-xs text-neutral-500 transition-colors hover:text-[#00ff88]"
			>
				<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
					<path d="M9 3L5 7l4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
				</svg>
				Back to projects
			</button>

			{#if loading}
				<div class="h-6 w-32 rounded skeleton-shimmer"></div>
				<div class="mt-2 h-3 w-40 rounded skeleton-shimmer"></div>
			{:else if project}
				<div in:fade={{ duration: 200 }}>
					<h2 class="truncate font-mono text-lg font-bold text-white">{project.name}</h2>
					<div class="mt-1 truncate font-mono text-xs text-neutral-500">
						{project.repo_owner}/{project.repo_name}
					</div>
					<div class="mt-1 font-mono text-xs text-neutral-600">
						<span class="text-neutral-700">branch:</span> {project.repo_branch}
					</div>
				</div>
			{:else}
				<div class="font-mono text-sm text-red-400">Project not found</div>
			{/if}
		</div>

		<div class="flex-1 space-y-4 px-6 py-6">
			<div class="font-mono text-xs uppercase tracking-widest text-neutral-600">Stats</div>

			<div class="rounded-lg border border-neutral-900 bg-[#111] p-4">
				<div class="font-mono text-xs text-neutral-500">Drifts (24h)</div>
				<div class="mt-1 font-mono text-2xl font-bold text-white">{driftsToday}</div>
				{#if criticalToday > 0}
					<div class="mt-2 inline-flex items-center gap-1.5 font-mono text-xs text-red-400">
						<span class="h-1.5 w-1.5 rounded-full bg-red-400 pulse-critical"></span>
						{criticalToday} critical
					</div>
				{/if}
			</div>

			<div class="rounded-lg border border-neutral-900 bg-[#111] p-4">
				<div class="font-mono text-xs text-neutral-500">Last check</div>
				<div class="mt-1 font-mono text-sm text-white">
					{snapshot ? timeAgo(snapshot.taken_at) : 'never'}
				</div>
			</div>

			{#if project}
				<div class="rounded-lg border border-neutral-900 bg-[#111] p-4">
					<div class="font-mono text-xs text-neutral-500">Docker host</div>
					<div class="mt-1 truncate font-mono text-xs text-neutral-300" title={project.docker_host}>
						{project.docker_host}
					</div>
				</div>
			{/if}
		</div>

		{#if project}
			<div class="border-t border-neutral-900 px-6 py-4">
				<button
					type="button"
					on:click={handleDelete}
					class="w-full rounded-md border border-red-900/50 px-3 py-2 font-mono text-xs text-red-400 transition-colors hover:bg-red-500/10"
				>
					Delete Project
				</button>
			</div>
		{/if}
	</aside>

	<!-- Mobile back -->
	<div class="md:hidden">
		<header class="flex items-center gap-3 border-b border-neutral-900 px-4 py-3">
			<button
				type="button"
				on:click={() => goto('/dashboard')}
				aria-label="Back"
				class="text-neutral-400 hover:text-white"
			>
				<svg width="20" height="20" viewBox="0 0 20 20" fill="none">
					<path d="M13 5l-5 5 5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
				</svg>
			</button>
			<div class="min-w-0 flex-1">
				<div class="truncate font-mono text-sm font-semibold">{project?.name ?? '…'}</div>
			</div>
		</header>
	</div>

	<main class="flex-1 overflow-x-hidden">
		<slot />
	</main>
</div>
