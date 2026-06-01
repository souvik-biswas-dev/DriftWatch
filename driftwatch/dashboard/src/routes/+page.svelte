<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';

	interface Particle {
		x: number;
		y: number;
		vx: number;
		vy: number;
	}

	let canvas: HTMLCanvasElement;
	let ctx: CanvasRenderingContext2D | null = null;
	let rafId = 0;
	let particles: Particle[] = [];
	let featuresEl: HTMLElement;

	const features = [
		{
			icon: '◉',
			title: 'Detect',
			desc: 'Continuously diff your live Docker state against your declared compose files. Drift surfaces in seconds, not days.'
		},
		{
			icon: '⚡',
			title: 'Analyze',
			desc: 'Gemini-powered AI summarizes every drift, traces the likely root cause, and recommends a one-line fix.'
		},
		{
			icon: '⟲',
			title: 'Remediate',
			desc: 'Copy the suggested command. Resolve in one click. Webhooks notify your team on Discord the moment drift appears.'
		}
	];

	// Tech stack shown in the footer. Color is each tool's brand color, used
	// for the dot so the row reads at a glance while staying on-theme.
	const techStack = [
		{ name: 'Go', color: '#00add8' },
		{ name: 'SvelteKit', color: '#ff3e00' },
		{ name: 'Cloudflare', color: '#f38020' },
		{ name: 'Postgres', color: '#4169e1' },
		{ name: 'Redis', color: '#ff4438' },
		{ name: 'Docker', color: '#2496ed' },
		{ name: 'Gemini AI', color: '#8e75ff' },
		{ name: 'Tailwind', color: '#38bdf8' }
	];

	function resize() {
		if (!canvas || !ctx) return;
		const dpr = window.devicePixelRatio || 1;
		canvas.width = window.innerWidth * dpr;
		canvas.height = window.innerHeight * dpr;
		canvas.style.width = window.innerWidth + 'px';
		canvas.style.height = window.innerHeight + 'px';
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.scale(dpr, dpr);
	}

	function spawn() {
		const count = Math.min(140, Math.floor((window.innerWidth * window.innerHeight) / 12000));
		particles = Array.from({ length: count }, () => ({
			x: Math.random() * window.innerWidth,
			y: Math.random() * window.innerHeight,
			vx: (Math.random() - 0.5) * 0.35,
			vy: (Math.random() - 0.5) * 0.35
		}));
	}

	function frame() {
		if (!ctx) return;
		const w = window.innerWidth;
		const h = window.innerHeight;
		ctx.clearRect(0, 0, w, h);

		for (const p of particles) {
			p.x += p.vx;
			p.y += p.vy;
			if (p.x < 0 || p.x > w) p.vx *= -1;
			if (p.y < 0 || p.y > h) p.vy *= -1;
		}

		ctx.lineWidth = 1;
		for (let i = 0; i < particles.length; i++) {
			for (let j = i + 1; j < particles.length; j++) {
				const dx = particles[i].x - particles[j].x;
				const dy = particles[i].y - particles[j].y;
				const distSq = dx * dx + dy * dy;
				if (distSq < 130 * 130) {
					const dist = Math.sqrt(distSq);
					const alpha = 1 - dist / 130;
					ctx.strokeStyle = `rgba(0, 255, 136, ${alpha * 0.22})`;
					ctx.beginPath();
					ctx.moveTo(particles[i].x, particles[i].y);
					ctx.lineTo(particles[j].x, particles[j].y);
					ctx.stroke();
				}
			}
		}

		ctx.fillStyle = '#00ff88';
		for (const p of particles) {
			ctx.beginPath();
			ctx.arc(p.x, p.y, 1.6, 0, Math.PI * 2);
			ctx.fill();
		}

		rafId = requestAnimationFrame(frame);
	}

	function scrollToFeatures() {
		featuresEl?.scrollIntoView({ behavior: 'smooth' });
	}

	onMount(() => {
		ctx = canvas.getContext('2d');
		resize();
		spawn();
		frame();
		window.addEventListener('resize', () => {
			resize();
			spawn();
		});
	});

	onDestroy(() => {
		// Guard: onDestroy also runs during SSR, where cancelAnimationFrame
		// (a browser API) is undefined.
		if (typeof cancelAnimationFrame !== 'undefined') {
			cancelAnimationFrame(rafId);
		}
	});
</script>

<svelte:head>
	<title>DriftWatch — Your infrastructure, always in sync</title>
</svelte:head>

<div class="relative min-h-screen overflow-x-hidden bg-[#0a0a0a]">
	<canvas bind:this={canvas} class="fixed inset-0 z-0" aria-hidden="true"></canvas>

	<!-- Top nav -->
	<nav class="relative z-20 flex items-center justify-between px-6 py-5 md:px-12">
		<a href="/" class="font-mono text-xl font-bold tracking-tight">
			<span class="text-white">Drift</span><span style="color: var(--accent)">Watch</span>
		</a>
		<a
			href="/dashboard"
			class="font-mono text-sm text-neutral-400 transition-colors hover:text-[#00ff88]"
		>
			Dashboard →
		</a>
	</nav>

	<!-- Hero -->
	<section class="relative z-10 flex min-h-[calc(100vh-80px)] flex-col items-center justify-center px-6 text-center">
		<div class="mb-6 inline-flex items-center gap-2 rounded-full border border-[#00ff88]/20 bg-[#00ff88]/5 px-4 py-1.5">
			<span class="h-1.5 w-1.5 animate-pulse rounded-full bg-[#00ff88]"></span>
			<span class="font-mono text-xs uppercase tracking-widest text-[#00ff88]">
				Autonomous Drift Detection
			</span>
		</div>

		<h1 class="font-mono text-6xl font-bold tracking-tight md:text-8xl">
			<span class="text-white">Drift</span><span style="color: var(--accent)">Watch</span>
		</h1>

		<p class="mt-6 max-w-xl text-lg text-neutral-400 md:text-xl">
			Your infrastructure, always in sync.
		</p>

		<div class="mt-10 flex flex-col gap-4 sm:flex-row">
			<button
				type="button"
				on:click={() => goto('/dashboard')}
				class="rounded-md px-8 py-3 font-mono font-semibold transition-all hover:scale-105"
				style="background: var(--accent); color: #0a0a0a; box-shadow: 0 0 30px rgba(0, 255, 136, 0.25);"
			>
				Get Started →
			</button>
			<button
				type="button"
				on:click={scrollToFeatures}
				class="rounded-md border border-neutral-700 px-8 py-3 font-mono font-semibold text-neutral-200 transition-colors hover:border-[#00ff88] hover:text-[#00ff88]"
			>
				View Demo
			</button>
		</div>

		<button
			type="button"
			on:click={scrollToFeatures}
			aria-label="Scroll to features"
			class="absolute bottom-8 animate-bounce text-neutral-500 transition-colors hover:text-neutral-300"
		>
			<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
				<path d="M5 7l5 5 5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
			</svg>
		</button>
	</section>

	<!-- Features -->
	<section
		bind:this={featuresEl}
		class="relative z-10 bg-[#0a0a0a]/85 px-6 py-24 backdrop-blur-sm"
	>
		<div class="mx-auto max-w-6xl">
			<div class="mb-16 text-center">
				<h2 class="font-mono text-3xl font-bold md:text-4xl">
					Three steps. Zero drift.
				</h2>
				<p class="mt-4 text-neutral-400">
					From detection to remediation in under a minute.
				</p>
			</div>

			<div class="grid grid-cols-1 gap-8 md:grid-cols-3">
				{#each features as f, i}
					<div
						class="group rounded-lg border border-neutral-800 bg-neutral-900/60 p-8 transition-all hover:border-[#00ff88]/40 hover:bg-neutral-900/80"
					>
						<div
							class="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-md bg-[#00ff88]/10 text-2xl"
							style="color: var(--accent)"
						>
							{f.icon}
						</div>
						<div class="mb-2 font-mono text-xs uppercase tracking-widest text-neutral-500">
							0{i + 1}
						</div>
						<h3 class="mb-3 font-mono text-xl font-semibold text-white">{f.title}</h3>
						<p class="leading-relaxed text-neutral-400">{f.desc}</p>
					</div>
				{/each}
			</div>
		</div>
	</section>

	<!-- Footer -->
	<footer class="relative z-10 border-t border-neutral-900 bg-[#0a0a0a] px-6 py-12">
		<div class="mx-auto max-w-6xl">
			<!-- Tech stack -->
			<div class="mb-10 text-center">
				<div class="mb-4 font-mono text-xs uppercase tracking-widest text-neutral-600">
					Built with
				</div>
				<div class="flex flex-wrap items-center justify-center gap-2.5">
					{#each techStack as t}
						<span
							class="inline-flex items-center gap-2 rounded-full border border-neutral-800 bg-neutral-900/50 px-3 py-1.5 font-mono text-xs text-neutral-300 transition-colors hover:border-neutral-700"
						>
							<span class="h-2 w-2 rounded-full" style="background: {t.color}"></span>
							{t.name}
						</span>
					{/each}
				</div>
			</div>

			<!-- Attribution + links -->
			<div
				class="flex flex-col items-center gap-4 border-t border-neutral-900 pt-8 md:flex-row md:justify-between"
			>
				<p class="font-mono text-sm text-neutral-500">
					Architected &amp; engineered by
					<a
						href="https://souvikbiswas-portfolio.pages.dev"
						target="_blank"
						rel="noopener noreferrer"
						class="font-semibold text-neutral-200 underline-offset-4 transition-colors hover:text-[#00ff88] hover:underline"
					>
						Souvik Biswas
					</a>
				</p>

				<div class="flex items-center gap-5">
					<a
						href="https://souvikbiswas-portfolio.pages.dev"
						target="_blank"
						rel="noopener noreferrer"
						class="inline-flex items-center gap-1.5 font-mono text-xs text-neutral-500 transition-colors hover:text-[#00ff88]"
						aria-label="Portfolio"
					>
						<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<circle cx="12" cy="12" r="10" />
							<line x1="2" y1="12" x2="22" y2="12" />
							<path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
						</svg>
						Portfolio
					</a>
					<a
						href="https://github.com/souvik-biswas-dev"
						target="_blank"
						rel="noopener noreferrer"
						class="inline-flex items-center gap-1.5 font-mono text-xs text-neutral-500 transition-colors hover:text-[#00ff88]"
						aria-label="GitHub"
					>
						<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
							<path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.5 11.5 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222 0 1.606-.014 2.898-.014 3.293 0 .322.216.694.825.576C20.565 22.092 24 17.595 24 12.297c0-6.627-5.373-12-12-12" />
						</svg>
						GitHub
					</a>
				</div>
			</div>

			<div class="mt-8 flex items-center justify-between font-mono text-xs text-neutral-700">
				<span>© {new Date().getFullYear()} DriftWatch</span>
				<span>infrastructure, always in sync</span>
			</div>
		</div>
	</footer>
</div>
