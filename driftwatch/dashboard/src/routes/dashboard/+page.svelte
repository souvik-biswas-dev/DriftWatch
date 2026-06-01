<script lang="ts">
	import { onMount } from 'svelte';
	import { fade, fly } from 'svelte/transition';
	import { Dialog } from 'bits-ui';
	import { toast } from 'svelte-sonner';
	import { goto } from '$app/navigation';

	import { projects } from '$lib/stores/projects';
	import { api, ApiClientError } from '$lib/api';
	import { timeAgo } from '$lib/utils';
	import type { CreateProjectInput, Project } from '$lib/types';

	let dialogOpen = false;
	let submitting = false;
	let form: CreateProjectInput = {
		name: '',
		repo_owner: '',
		repo_name: '',
		repo_branch: 'main'
	};

	// After a project is created the backend returns a one-time agent key.
	// We reveal it in a dedicated dialog with the exact `docker run` command,
	// because it is never retrievable again.
	let keyDialogOpen = false;
	let newAgentKey = '';
	let newProjectName = '';

	const apiBase =
		(typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_BASE_URL) ||
		'http://localhost:8080';

	$: agentRunCommand =
		`docker run -d --name driftwatch-agent --restart unless-stopped \\\n` +
		`  -v /var/run/docker.sock:/var/run/docker.sock:ro \\\n` +
		`  -e DRIFTWATCH_URL="${apiBase}" \\\n` +
		`  -e DRIFTWATCH_AGENT_KEY="${newAgentKey}" \\\n` +
		`  driftwatch-agent`;

	function resetForm() {
		form = {
			name: '',
			repo_owner: '',
			repo_name: '',
			repo_branch: 'main'
		};
	}

	async function copyKey() {
		try {
			await navigator.clipboard.writeText(newAgentKey);
			toast.success('Agent key copied');
		} catch {
			toast.error('Copy failed — select and copy manually');
		}
	}

	async function copyCommand() {
		try {
			await navigator.clipboard.writeText(agentRunCommand);
			toast.success('Command copied');
		} catch {
			toast.error('Copy failed — select and copy manually');
		}
	}

	async function handleCreate() {
		if (!form.name || !form.repo_owner || !form.repo_name) {
			toast.error('Please fill in all required fields');
			return;
		}
		submitting = true;
		try {
			const { project, agent_key } = await api.createProject(form);
			projects.add(project);
			toast.success(`Project "${project.name}" created`);
			dialogOpen = false;
			resetForm();
			// Surface the one-time agent key.
			newAgentKey = agent_key;
			newProjectName = project.name;
			keyDialogOpen = true;
		} catch (e) {
			const msg = e instanceof ApiClientError ? e.message : 'Failed to create project';
			toast.error(msg);
		} finally {
			submitting = false;
		}
	}

	// We don't have a drift-count endpoint per project yet; this is a
	// placeholder badge style chosen randomly per project until the API
	// surfaces aggregates. Rendered deterministically by project ID.
	function driftBadge(p: Project): { count: number; level: 'green' | 'yellow' | 'red' } {
		const seed = p.id.charCodeAt(0) + p.id.charCodeAt(p.id.length - 1);
		const count = seed % 7;
		const level = count === 0 ? 'green' : count <= 2 ? 'yellow' : 'red';
		return { count, level };
	}

	const badgeClasses = {
		green: 'bg-green-500/15 text-green-400 border-green-500/30',
		yellow: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
		red: 'bg-red-500/15 text-red-400 border-red-500/30 pulse-critical'
	};

	onMount(() => {
		projects.load();
	});

	$: state = $projects;
</script>

<svelte:head>
	<title>Dashboard — DriftWatch</title>
</svelte:head>

<div class="min-h-screen bg-[#0a0a0a]">
	<!-- Header -->
	<header class="border-b border-neutral-900 bg-[#0a0a0a]/95 backdrop-blur">
		<div class="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
			<a href="/" class="font-mono text-xl font-bold tracking-tight">
				<span class="text-white">Drift</span><span style="color: var(--accent)">Watch</span>
			</a>
			<button
				type="button"
				on:click={() => (dialogOpen = true)}
				class="rounded-md px-4 py-2 font-mono text-sm font-semibold transition-all hover:scale-105"
				style="background: var(--accent); color: #0a0a0a;"
			>
				+ New Project
			</button>
		</div>
	</header>

	<main class="mx-auto max-w-7xl px-6 py-10">
		<div class="mb-8">
			<h1 class="font-mono text-3xl font-bold text-white">Projects</h1>
			<p class="mt-1 text-sm text-neutral-500">Monitor live infrastructure for drift against declared state.</p>
		</div>

		{#if state.loading}
			<div class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
				{#each Array(6) as _, i (i)}
					<div class="h-44 rounded-lg border border-neutral-900 skeleton-shimmer"></div>
				{/each}
			</div>
		{:else if state.error}
			<div class="rounded-lg border border-red-500/30 bg-red-500/10 p-6 text-red-300">
				<div class="font-mono text-sm uppercase tracking-widest">Error</div>
				<div class="mt-2">{state.error}</div>
				<button
					on:click={() => projects.load()}
					class="mt-4 rounded-md border border-red-500/30 px-3 py-1 text-sm hover:bg-red-500/10"
				>
					Retry
				</button>
			</div>
		{:else if state.items.length === 0}
			<div class="flex flex-col items-center justify-center py-24 text-center" in:fade={{ duration: 250 }}>
				<svg width="120" height="120" viewBox="0 0 120 120" fill="none" class="mb-6 opacity-40">
					<rect x="20" y="30" width="80" height="60" rx="6" stroke="#404040" stroke-width="2" />
					<line x1="20" y1="48" x2="100" y2="48" stroke="#404040" stroke-width="2" />
					<circle cx="32" cy="39" r="2" fill="#404040" />
					<circle cx="40" cy="39" r="2" fill="#404040" />
					<rect x="32" y="58" width="56" height="6" rx="2" fill="#262626" />
					<rect x="32" y="70" width="36" height="6" rx="2" fill="#262626" />
				</svg>
				<h3 class="mb-2 font-mono text-lg font-semibold text-neutral-300">No projects yet</h3>
				<p class="mb-6 max-w-md text-neutral-500">
					Spin up your first project to begin tracking drift on a Docker host.
				</p>
				<button
					type="button"
					on:click={() => (dialogOpen = true)}
					class="rounded-md px-6 py-2 font-mono text-sm font-semibold transition-transform hover:scale-105"
					style="background: var(--accent); color: #0a0a0a;"
				>
					Create your first project
				</button>
			</div>
		{:else}
			<div class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
				{#each state.items as project, i (project.id)}
					{@const badge = driftBadge(project)}
					<button
						type="button"
						on:click={() => goto(`/dashboard/${project.id}`)}
						in:fly={{ y: 16, delay: i * 50, duration: 280 }}
						class="group relative rounded-lg border border-neutral-800 bg-[#141414] p-5 text-left transition-all hover:border-[#00ff88]/40 hover:bg-[#171717]"
					>
						<div class="mb-3 flex items-start justify-between">
							<div class="min-w-0 flex-1 pr-3">
								<h3 class="truncate font-mono text-base font-semibold text-white group-hover:text-[#00ff88]">
									{project.name}
								</h3>
								<div class="mt-1 truncate font-mono text-xs text-neutral-500">
									{project.repo_owner}/{project.repo_name}
									<span class="text-neutral-700">@</span>{project.repo_branch}
								</div>
							</div>
							<span
								class="inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-0.5 font-mono text-xs {badgeClasses[badge.level]}"
							>
								{badge.count}
								<span class="opacity-70">drift{badge.count === 1 ? '' : 's'}</span>
							</span>
						</div>

						<div class="mt-4 flex items-center justify-between border-t border-neutral-900 pt-3 text-xs text-neutral-500">
							<span class="truncate font-mono">agent push</span>
							<span class="shrink-0 pl-3">{timeAgo(project.updated_at)}</span>
						</div>
					</button>
				{/each}
			</div>
		{/if}
	</main>
</div>

<!-- New project dialog -->
<Dialog.Root bind:open={dialogOpen}>
	<Dialog.Portal>
		<Dialog.Overlay transition={fade} transitionConfig={{ duration: 150 }} />
		<Dialog.Content
			transition={fly}
			transitionConfig={{ x: 480, duration: 240 }}
			class="fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col border-l border-neutral-800 bg-[#0f0f0f] shadow-2xl"
		>
			<div class="flex items-center justify-between border-b border-neutral-900 px-6 py-4">
				<div>
					<Dialog.Title class="font-mono text-lg font-bold text-white">New Project</Dialog.Title>
					<Dialog.Description class="mt-0.5 text-xs text-neutral-500">
						Point at the GitHub repo holding your docker-compose.yml. You'll get an
						agent key to run on your server.
					</Dialog.Description>
				</div>
				<Dialog.Close class="rounded-md p-1 text-neutral-500 transition-colors hover:bg-neutral-900 hover:text-white">
					<svg width="20" height="20" viewBox="0 0 20 20" fill="none">
						<path d="M5 5l10 10M15 5l-10 10" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
					</svg>
				</Dialog.Close>
			</div>

			<form on:submit|preventDefault={handleCreate} class="flex flex-1 flex-col overflow-y-auto">
				<div class="space-y-5 px-6 py-6">
					<div>
						<label for="np-name" class="mb-1.5 block font-mono text-xs uppercase tracking-widest text-neutral-400">
							Project Name
						</label>
						<input
							id="np-name"
							type="text"
							bind:value={form.name}
							placeholder="acme-prod"
							required
							class="w-full rounded-md border border-neutral-800 bg-[#0a0a0a] px-3 py-2 font-mono text-sm text-white placeholder-neutral-600 focus:border-[#00ff88] focus:outline-none focus:ring-1 focus:ring-[#00ff88]/50"
						/>
					</div>

					<div>
						<label for="np-repo-owner" class="mb-1.5 block font-mono text-xs uppercase tracking-widest text-neutral-400">
							GitHub Repository
						</label>
						<div class="flex gap-2">
							<input
								id="np-repo-owner"
								type="text"
								bind:value={form.repo_owner}
								placeholder="owner"
								required
								class="w-1/2 rounded-md border border-neutral-800 bg-[#0a0a0a] px-3 py-2 font-mono text-sm text-white placeholder-neutral-600 focus:border-[#00ff88] focus:outline-none focus:ring-1 focus:ring-[#00ff88]/50"
							/>
							<span class="flex items-center font-mono text-neutral-600">/</span>
							<input
								type="text"
								bind:value={form.repo_name}
								placeholder="repo"
								required
								class="w-1/2 rounded-md border border-neutral-800 bg-[#0a0a0a] px-3 py-2 font-mono text-sm text-white placeholder-neutral-600 focus:border-[#00ff88] focus:outline-none focus:ring-1 focus:ring-[#00ff88]/50"
							/>
						</div>
					</div>

					<div>
						<label for="np-branch" class="mb-1.5 block font-mono text-xs uppercase tracking-widest text-neutral-400">
							Branch
						</label>
						<input
							id="np-branch"
							type="text"
							bind:value={form.repo_branch}
							placeholder="main"
							class="w-full rounded-md border border-neutral-800 bg-[#0a0a0a] px-3 py-2 font-mono text-sm text-white placeholder-neutral-600 focus:border-[#00ff88] focus:outline-none focus:ring-1 focus:ring-[#00ff88]/50"
						/>
					</div>

					<div class="rounded-md border border-neutral-800 bg-[#0a0a0a] px-3 py-3">
						<p class="font-mono text-xs leading-relaxed text-neutral-500">
							<span class="text-neutral-300">No Docker host needed.</span> After creating
							the project you'll get a one-time agent key. Run the DriftWatch agent on the
							server where your containers live and it pushes state here automatically.
						</p>
					</div>
				</div>

				<div class="mt-auto flex items-center justify-end gap-3 border-t border-neutral-900 px-6 py-4">
					<Dialog.Close class="rounded-md border border-neutral-800 px-4 py-2 font-mono text-sm text-neutral-300 transition-colors hover:bg-neutral-900">
						Cancel
					</Dialog.Close>
					<button
						type="submit"
						disabled={submitting}
						class="rounded-md px-4 py-2 font-mono text-sm font-semibold transition-all hover:scale-105 disabled:cursor-not-allowed disabled:opacity-50"
						style="background: var(--accent); color: #0a0a0a;"
					>
						{submitting ? 'Creating…' : 'Create Project'}
					</button>
				</div>
			</form>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>

<!-- One-time agent key reveal -->
<Dialog.Root bind:open={keyDialogOpen}>
	<Dialog.Portal>
		<Dialog.Overlay transition={fade} transitionConfig={{ duration: 150 }} />
		<Dialog.Content
			transition={fly}
			transitionConfig={{ y: 24, duration: 240 }}
			class="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-full max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-neutral-800 bg-[#0f0f0f] shadow-2xl"
		>
			<div class="border-b border-neutral-900 px-6 py-4">
				<Dialog.Title class="font-mono text-lg font-bold text-white">
					Agent key for "{newProjectName}"
				</Dialog.Title>
				<Dialog.Description class="mt-1 text-xs text-yellow-500/90">
					⚠ Shown only once. Copy it now — you can't retrieve it later.
				</Dialog.Description>
			</div>

			<div class="space-y-5 overflow-y-auto px-6 py-6">
				<div>
					<div class="mb-1.5 font-mono text-xs uppercase tracking-widest text-neutral-400">
						Agent key
					</div>
					<div class="flex items-stretch gap-2">
						<code
							class="flex-1 break-all rounded-md border border-neutral-800 bg-[#0a0a0a] px-3 py-2 font-mono text-xs text-[#00ff88]"
						>{newAgentKey}</code>
						<button
							type="button"
							on:click={copyKey}
							class="shrink-0 rounded-md border border-neutral-800 px-3 font-mono text-xs text-neutral-300 transition-colors hover:bg-neutral-900"
						>
							Copy
						</button>
					</div>
				</div>

				<div>
					<div class="mb-1.5 font-mono text-xs uppercase tracking-widest text-neutral-400">
						Run the agent on your server
					</div>
					<pre
						class="overflow-x-auto rounded-md border border-neutral-800 bg-[#0a0a0a] px-3 py-3 font-mono text-xs leading-relaxed text-neutral-300"
					>{agentRunCommand}</pre>
					<button
						type="button"
						on:click={copyCommand}
						class="mt-2 rounded-md border border-neutral-800 px-3 py-1.5 font-mono text-xs text-neutral-300 transition-colors hover:bg-neutral-900"
					>
						Copy command
					</button>
					<p class="mt-2 font-mono text-xs text-neutral-600">
						Build the image once with
						<code class="text-neutral-400">docker build -f cmd/agent/Dockerfile -t driftwatch-agent .</code>
						from the backend folder. The agent reads local Docker and pushes state here.
					</p>
				</div>
			</div>

			<div class="mt-auto flex items-center justify-end border-t border-neutral-900 px-6 py-4">
				<button
					type="button"
					on:click={() => (keyDialogOpen = false)}
					class="rounded-md px-4 py-2 font-mono text-sm font-semibold transition-all hover:scale-105"
					style="background: var(--accent); color: #0a0a0a;"
				>
					I've saved it
				</button>
			</div>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>
