<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { fly, slide } from 'svelte/transition';
	import { page } from '$app/stores';
	import { toast } from 'svelte-sonner';
	import * as d3 from 'd3';

	import { api, ApiClientError } from '$lib/api';
	import { timeAgo, severityColor, severityBgClass, driftTypeLabel } from '$lib/utils';
	import type { DriftEvent, Severity } from '$lib/types';

	let drifts: DriftEvent[] = [];
	let loading = true;
	let expandedId: string | null = null;
	let copiedId: string | null = null;
	let copyTimer: ReturnType<typeof setTimeout> | null = null;

	let lastUpdated = new Date();
	let secondsAgo = 0;
	let chartEl: HTMLDivElement;
	let pollHandle: ReturnType<typeof setInterval> | null = null;
	let tickHandle: ReturnType<typeof setInterval> | null = null;
	let resizeHandle: (() => void) | null = null;

	// Route is /dashboard/[id], so params.id is always present at runtime; the
	// ?? '' satisfies SvelteKit's string | undefined param typing.
	$: projectId = $page.params.id ?? '';

	async function loadDrifts() {
		try {
			const ds = await api.listDrifts(projectId);
			drifts = ds ?? [];
			lastUpdated = new Date();
			secondsAgo = 0;
			drawChart();
		} catch (e) {
			const msg = e instanceof ApiClientError ? e.message : 'failed to load drifts';
			toast.error(msg);
		} finally {
			loading = false;
		}
	}

	function toggleExpanded(id: string) {
		expandedId = expandedId === id ? null : id;
	}

	async function copyCommand(id: string, cmd: string) {
		try {
			await navigator.clipboard.writeText(cmd);
			copiedId = id;
			if (copyTimer) clearTimeout(copyTimer);
			copyTimer = setTimeout(() => {
				copiedId = null;
			}, 2000);
		} catch {
			toast.error('clipboard unavailable');
		}
	}

	async function handleResolve(drift: DriftEvent, e: Event) {
		e.stopPropagation();
		try {
			await api.resolveDrift(projectId, drift.id);
			drifts = drifts.map((d) =>
				d.id === drift.id ? { ...d, resolved_at: new Date().toISOString() } : d
			);
			drawChart();
			toast.success(`Resolved drift on ${drift.container_name}`);
		} catch (err) {
			const msg = err instanceof ApiClientError ? err.message : 'failed to resolve drift';
			toast.error(msg);
		}
	}

	function drawChart() {
		if (!chartEl) return;
		const width = chartEl.clientWidth;
		const height = 220;
		const margin = { top: 24, right: 24, bottom: 32, left: 80 };

		d3.select(chartEl).selectAll('*').remove();
		const svg = d3
			.select(chartEl)
			.append('svg')
			.attr('width', width)
			.attr('height', height)
			.attr('viewBox', `0 0 ${width} ${height}`);

		const now = new Date();
		const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);

		const x = d3
			.scaleTime()
			.domain([start, now])
			.range([margin.left, width - margin.right]);

		const severities: Severity[] = ['critical', 'warning', 'info'];
		const y = d3
			.scalePoint<Severity>()
			.domain(severities)
			.range([margin.top, height - margin.bottom])
			.padding(0.5);

		// horizontal gridlines per severity
		svg
			.append('g')
			.attr('class', 'grid')
			.selectAll('line')
			.data(severities)
			.enter()
			.append('line')
			.attr('x1', margin.left)
			.attr('x2', width - margin.right)
			.attr('y1', (d) => y(d) ?? 0)
			.attr('y2', (d) => y(d) ?? 0)
			.attr('stroke', '#1a1a1a')
			.attr('stroke-dasharray', '2,4');

		// x axis
		svg
			.append('g')
			.attr('class', 'axis')
			.attr('transform', `translate(0, ${height - margin.bottom})`)
			.call(
				d3
					.axisBottom<Date>(x)
					.ticks(width < 600 ? 4 : 8)
					.tickFormat((d) => d3.timeFormat('%H:%M')(d as Date))
			);

		// y axis
		svg
			.append('g')
			.attr('class', 'axis')
			.attr('transform', `translate(${margin.left}, 0)`)
			.call(d3.axisLeft(y));

		// dots
		const recent = drifts.filter((d) => new Date(d.created_at) >= start);
		svg
			.selectAll('circle.drift')
			.data(recent)
			.enter()
			.append('circle')
			.attr('class', 'drift')
			.attr('cx', (d) => x(new Date(d.created_at)))
			.attr('cy', (d) => y(d.severity) ?? 0)
			.attr('r', (d) => (d.resolved_at ? 3.5 : 5))
			.attr('fill', (d) => severityColor(d.severity))
			.attr('opacity', (d) => (d.resolved_at ? 0.35 : 0.9))
			.attr('stroke', (d) => severityColor(d.severity))
			.attr('stroke-width', 1)
			.append('title')
			.text((d) => `${d.container_name} · ${driftTypeLabel(d.drift_type)} · ${timeAgo(d.created_at)}`);
	}

	onMount(() => {
		loadDrifts();

		pollHandle = setInterval(loadDrifts, 30_000);
		tickHandle = setInterval(() => {
			secondsAgo = Math.floor((Date.now() - lastUpdated.getTime()) / 1000);
		}, 1000);

		resizeHandle = () => drawChart();
		window.addEventListener('resize', resizeHandle);
	});

	onDestroy(() => {
		if (pollHandle) clearInterval(pollHandle);
		if (tickHandle) clearInterval(tickHandle);
		if (copyTimer) clearTimeout(copyTimer);
		if (resizeHandle && typeof window !== 'undefined') {
			window.removeEventListener('resize', resizeHandle);
		}
	});

	$: openDrifts = drifts.filter((d) => !d.resolved_at);
	$: resolvedDrifts = drifts.filter((d) => !!d.resolved_at);
</script>

<div class="px-6 py-8 md:px-10">
	<!-- Header row -->
	<div class="mb-6 flex items-center justify-between">
		<div>
			<h1 class="font-mono text-2xl font-bold text-white">Drift Timeline</h1>
			<p class="mt-1 text-sm text-neutral-500">Last 24 hours of detected drift events.</p>
		</div>
		<div class="flex items-center gap-2 font-mono text-xs text-neutral-500">
			<span class="h-1.5 w-1.5 rounded-full bg-[#00ff88]"></span>
			Last updated {secondsAgo}s ago
		</div>
	</div>

	<!-- Timeline -->
	<div class="mb-10 rounded-lg border border-neutral-900 bg-[#0f0f0f] p-4">
		<div bind:this={chartEl} class="w-full"></div>
		{#if !loading && drifts.length === 0}
			<div class="py-6 text-center font-mono text-sm text-neutral-600">
				No drift events recorded in the last 24 hours.
			</div>
		{/if}
	</div>

	<!-- Drift list -->
	<div class="mb-4 flex items-center justify-between">
		<h2 class="font-mono text-lg font-semibold text-white">
			Drift Events
			<span class="ml-2 font-mono text-sm text-neutral-500">
				({openDrifts.length} open
				{#if resolvedDrifts.length}, {resolvedDrifts.length} resolved{/if})
			</span>
		</h2>
	</div>

	{#if loading}
		<div class="space-y-3">
			{#each Array(4) as _, i (i)}
				<div class="h-24 rounded-lg border border-neutral-900 skeleton-shimmer"></div>
			{/each}
		</div>
	{:else if drifts.length === 0}
		<div class="rounded-lg border border-neutral-900 bg-[#0f0f0f] py-12 text-center">
			<div class="mb-2 font-mono text-3xl" style="color: var(--accent)">✓</div>
			<div class="font-mono text-sm text-neutral-300">No drift detected.</div>
			<div class="mt-1 text-xs text-neutral-500">
				Live state matches declared configuration.
			</div>
		</div>
	{:else}
		<div class="space-y-3">
			{#each drifts as drift, i (drift.id)}
				{@const isExpanded = expandedId === drift.id}
				{@const isResolved = !!drift.resolved_at}
				<div
					in:fly={{ y: 14, delay: i * 50, duration: 280 }}
					class="overflow-hidden rounded-lg border bg-[#0f0f0f] transition-colors {isResolved
						? 'border-neutral-900 opacity-60'
						: 'border-neutral-800 hover:border-neutral-700'}"
				>
					<button
						type="button"
						on:click={() => toggleExpanded(drift.id)}
						class="w-full px-5 py-4 text-left"
					>
						<div class="flex items-start justify-between gap-4">
							<div class="min-w-0 flex-1">
								<div class="mb-2 flex flex-wrap items-center gap-2">
									<span class="font-mono text-sm font-semibold text-white">
										{drift.container_name}
									</span>
									<span class="rounded border border-neutral-800 bg-neutral-900 px-2 py-0.5 font-mono text-xs text-neutral-400">
										{driftTypeLabel(drift.drift_type)}
									</span>
									<span
										class="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-xs uppercase tracking-wider {severityBgClass(
											drift.severity
										)} {drift.severity === 'critical' && !isResolved ? 'pulse-critical' : ''}"
									>
										<span class="h-1 w-1 rounded-full" style="background: {severityColor(drift.severity)}"></span>
										{drift.severity}
									</span>
									{#if isResolved}
										<span class="rounded border border-green-500/30 bg-green-500/10 px-2 py-0.5 font-mono text-xs text-green-400">
											resolved
										</span>
									{/if}
								</div>

								{#if drift.ai_summary}
									<p class="text-sm text-neutral-400 line-clamp-2">{drift.ai_summary}</p>
								{:else}
									<p class="font-mono text-xs text-neutral-500">
										{drift.declared_value ?? '—'} → {drift.live_value ?? '—'}
									</p>
								{/if}
							</div>

							<div class="flex shrink-0 items-center gap-3">
								<span class="font-mono text-xs text-neutral-500">{timeAgo(drift.created_at)}</span>
								<svg
									width="16"
									height="16"
									viewBox="0 0 16 16"
									fill="none"
									class="text-neutral-600 transition-transform {isExpanded ? 'rotate-180' : ''}"
								>
									<path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
								</svg>
							</div>
						</div>
					</button>

					{#if isExpanded}
						<div transition:slide={{ duration: 220 }} class="border-t border-neutral-900 px-5 py-4">
							<div class="grid grid-cols-1 gap-4 md:grid-cols-2">
								<div>
									<div class="mb-1 font-mono text-xs uppercase tracking-widest text-neutral-500">
										Declared
									</div>
									<div class="rounded border border-neutral-900 bg-[#0a0a0a] p-3 font-mono text-xs text-neutral-300 break-all">
										{drift.declared_value || '—'}
									</div>
								</div>
								<div>
									<div class="mb-1 font-mono text-xs uppercase tracking-widest text-neutral-500">
										Live
									</div>
									<div class="rounded border border-neutral-900 bg-[#0a0a0a] p-3 font-mono text-xs text-neutral-300 break-all">
										{drift.live_value || '—'}
									</div>
								</div>
							</div>

							{#if drift.ai_summary}
								<div class="mt-4">
									<div class="mb-1 font-mono text-xs uppercase tracking-widest text-neutral-500">
										AI Analysis
									</div>
									<div class="rounded border border-neutral-900 bg-[#0a0a0a] p-3 text-sm text-neutral-300">
										{drift.ai_summary}
									</div>
								</div>
							{/if}

							{#if drift.fix_command}
								<div class="mt-4">
									<div class="mb-1 flex items-center justify-between">
										<div class="font-mono text-xs uppercase tracking-widest text-neutral-500">
											Fix Command
										</div>
										<button
											type="button"
											on:click|stopPropagation={() => copyCommand(drift.id, drift.fix_command ?? '')}
											class="inline-flex items-center gap-1.5 rounded border border-neutral-800 px-2 py-1 font-mono text-xs text-neutral-300 transition-colors hover:border-[#00ff88] hover:text-[#00ff88]"
										>
											{#if copiedId === drift.id}
												<svg width="12" height="12" viewBox="0 0 12 12" fill="none">
													<path d="M2 6l3 3 5-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
												</svg>
												Copied
											{:else}
												<svg width="12" height="12" viewBox="0 0 12 12" fill="none">
													<rect x="3" y="3" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.2" />
													<path d="M1.5 1.5h6v6" stroke="currentColor" stroke-width="1.2" fill="none" />
												</svg>
												Copy
											{/if}
										</button>
									</div>
									<pre class="overflow-x-auto rounded border border-neutral-900 bg-black p-3 font-mono text-xs text-[#00ff88]"><code>{drift.fix_command}</code></pre>
								</div>
							{/if}

							{#if !isResolved}
								<div class="mt-5 flex justify-end">
									<button
										type="button"
										on:click={(e) => handleResolve(drift, e)}
										class="rounded-md px-4 py-2 font-mono text-xs font-semibold transition-all hover:scale-105"
										style="background: var(--accent); color: #0a0a0a;"
									>
										Mark Resolved
									</button>
								</div>
							{/if}
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>
