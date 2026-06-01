<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import Logo from '$lib/Logo.svelte';

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

	// Tech stack shown in the footer. `icon` is the official Simple Icons SVG
	// path (24x24 viewBox), rendered in the brand `color`.
	const techStack = [
		{
			name: 'Go',
			color: '#00add8',
			icon: 'M1.811 10.231c-.047 0-.058-.023-.035-.059l.246-.315c.023-.035.081-.058.128-.058h4.172c.046 0 .058.035.035.07l-.199.303c-.023.036-.082.07-.117.07zM.047 11.306c-.047 0-.059-.023-.035-.058l.245-.316c.023-.035.082-.058.129-.058h5.328c.047 0 .07.035.058.07l-.093.28c-.012.047-.058.07-.105.07zm2.828 1.075c-.047 0-.059-.035-.035-.07l.163-.292c.023-.035.07-.07.117-.07h2.337c.047 0 .07.035.07.082l-.023.28c0 .047-.047.082-.082.082zm12.129-2.36c-.736.187-1.239.327-1.963.514-.176.046-.187.058-.34-.117-.174-.199-.303-.327-.548-.444-.737-.362-1.45-.257-2.115.175-.795.514-1.204 1.274-1.192 2.22.011.935.654 1.706 1.577 1.835.795.105 1.46-.175 1.987-.77.105-.13.198-.27.315-.434H10.47c-.245 0-.304-.152-.222-.35.152-.362.432-.97.596-1.274a.315.315 0 01.292-.187h4.253c-.023.316-.023.631-.07.947a4.983 4.983 0 01-.958 2.29c-.841 1.11-1.94 1.8-3.33 1.986-1.145.152-2.209-.07-3.143-.77-.865-.655-1.356-1.52-1.484-2.595-.152-1.274.222-2.419.993-3.424.83-1.086 1.928-1.776 3.272-2.02 1.098-.2 2.15-.07 3.096.571.62.41 1.063.97 1.356 1.648.07.105.023.164-.117.2m3.868 6.461c-1.064-.024-2.034-.328-2.852-1.029a3.665 3.665 0 01-1.262-2.255c-.21-1.32.152-2.489.947-3.529.853-1.122 1.881-1.706 3.272-1.95 1.192-.21 2.314-.095 3.33.595.923.63 1.496 1.484 1.648 2.605.198 1.578-.257 2.863-1.344 3.962-.771.783-1.718 1.273-2.805 1.495-.315.06-.63.07-.934.106zm2.78-4.72c-.011-.153-.011-.27-.034-.387-.21-1.157-1.274-1.81-2.384-1.554-1.087.245-1.788.935-2.045 2.033-.21.912.234 1.835 1.075 2.21.643.28 1.285.244 1.905-.07.923-.48 1.425-1.228 1.484-2.233z'
		},
		{
			name: 'SvelteKit',
			color: '#ff3e00',
			icon: 'M10.354 21.125a4.44 4.44 0 0 1-4.765-1.767 4.109 4.109 0 0 1-.703-3.107 3.898 3.898 0 0 1 .134-.522l.105-.321.287.21a7.21 7.21 0 0 0 2.186 1.092l.208.063-.02.208a1.253 1.253 0 0 0 .226.83 1.337 1.337 0 0 0 1.435.533 1.231 1.231 0 0 0 .343-.15l5.59-3.562a1.164 1.164 0 0 0 .524-.778 1.242 1.242 0 0 0-.211-.937 1.338 1.338 0 0 0-1.435-.533 1.23 1.23 0 0 0-.343.15l-2.133 1.36a4.078 4.078 0 0 1-1.135.499 4.44 4.44 0 0 1-4.765-1.766 4.108 4.108 0 0 1-.702-3.108 3.855 3.855 0 0 1 1.742-2.582l5.589-3.563a4.072 4.072 0 0 1 1.135-.499 4.44 4.44 0 0 1 4.765 1.767 4.109 4.109 0 0 1 .703 3.107 3.943 3.943 0 0 1-.134.522l-.105.321-.286-.21a7.204 7.204 0 0 0-2.187-1.093l-.208-.063.02-.207a1.255 1.255 0 0 0-.226-.831 1.337 1.337 0 0 0-1.435-.532 1.231 1.231 0 0 0-.343.15L8.62 9.368a1.162 1.162 0 0 0-.524.778 1.24 1.24 0 0 0 .211.937 1.338 1.338 0 0 0 1.435.533 1.235 1.235 0 0 0 .344-.151l2.132-1.36a4.067 4.067 0 0 1 1.135-.498 4.44 4.44 0 0 1 4.765 1.766 4.108 4.108 0 0 1 .702 3.108 3.857 3.857 0 0 1-1.742 2.583l-5.589 3.562a4.072 4.072 0 0 1-1.135.499m10.358-17.95C18.484-.015 14.082-.96 10.9 1.068L5.31 4.63a6.412 6.412 0 0 0-2.896 4.295 6.753 6.753 0 0 0 .666 4.336 6.43 6.43 0 0 0-.96 2.396 6.833 6.833 0 0 0 1.168 5.167c2.229 3.19 6.63 4.135 9.812 2.108l5.59-3.562a6.41 6.41 0 0 0 2.896-4.295 6.756 6.756 0 0 0-.665-4.336 6.429 6.429 0 0 0 .958-2.396 6.831 6.831 0 0 0-1.167-5.168Z'
		},
		{
			name: 'Cloudflare',
			color: '#f38020',
			icon: 'M16.5088 16.8447c.1475-.5068.0908-.9707-.1553-1.3154-.2246-.3164-.6045-.499-1.0615-.5205l-8.6592-.1123a.1559.1559 0 0 1-.1333-.0713c-.0283-.042-.0351-.0986-.021-.1553.0278-.084.1123-.1484.2036-.1562l8.7359-.1123c1.0351-.0489 2.1601-.8868 2.5537-1.9136l.499-1.3013c.0215-.0561.0293-.1128.0147-.168-.5625-2.5463-2.835-4.4453-5.5499-4.4453-2.5039 0-4.6284 1.6177-5.3876 3.8614-.4927-.3658-1.1187-.5625-1.794-.499-1.2026.119-2.1665 1.083-2.2861 2.2856-.0283.31-.0069.6128.0635.894C1.5683 13.171 0 14.7754 0 16.752c0 .1748.0142.3515.0352.5273.0141.083.0844.1475.1689.1475h15.9814c.0909 0 .1758-.0645.2032-.1553l.12-.4268zm2.7568-5.5634c-.0771 0-.1611 0-.2383.0112-.0566 0-.1054.0415-.127.0976l-.3378 1.1744c-.1475.5068-.0918.9707.1543 1.3164.2256.3164.6055.498 1.0625.5195l1.8437.1133c.0557 0 .1055.0263.1329.0703.0283.043.0351.1074.0214.1562-.0283.084-.1132.1485-.204.1553l-1.921.1123c-1.041.0488-2.1582.8867-2.5527 1.914l-.1406.3585c-.0283.0713.0215.1416.0986.1416h6.5977c.0771 0 .1474-.0489.169-.126.1122-.4082.1757-.837.1757-1.2803 0-2.6025-2.125-4.727-4.7344-4.727'
		},
		{
			name: 'Postgres',
			color: '#4169e1',
			icon: 'M23.5594 14.7228a.5269.5269 0 0 0-.0563-.1191c-.139-.2632-.4768-.3418-1.0074-.2321-1.6533.3411-2.2935.1312-2.5256-.0191 1.342-2.0482 2.445-4.522 3.0411-6.8297.2714-1.0507.7982-3.5237.1222-4.7316a1.5641 1.5641 0 0 0-.1509-.235C21.6931.9086 19.8007.0248 17.5099.0005c-1.4947-.0158-2.7705.3461-3.1161.4794a9.449 9.449 0 0 0-.5159-.0816 8.044 8.044 0 0 0-1.3114-.1278c-1.1822-.0184-2.2038.2642-3.0498.8406-.8573-.3211-4.7888-1.645-7.2219.0788C.9359 2.1526.3086 3.8733.4302 6.3043c.0409.818.5069 3.334 1.2423 5.7436.4598 1.5065.9387 2.7019 1.4334 3.582.553.9942 1.1259 1.5933 1.7143 1.7895.4474.1491 1.1327.1441 1.8581-.7279.8012-.9635 1.5903-1.8258 1.9446-2.2069.4351.2355.9064.3625 1.39.3772a.0569.0569 0 0 0 .0004.0041 11.0312 11.0312 0 0 0-.2472.3054c-.3389.4302-.4094.5197-1.5002.7443-.3102.064-1.1344.2339-1.1464.8115-.0025.1224.0329.2309.0919.3268.2269.4231.9216.6097 1.015.6331 1.3345.3335 2.5044.092 3.3714-.6787-.017 2.231.0775 4.4174.3454 5.0874.2212.5529.7618 1.9045 2.4692 1.9043.2505 0 .5263-.0291.8296-.0941 1.7819-.3821 2.5557-1.1696 2.855-2.9059.1503-.8707.4016-2.8753.5388-4.1012.0169-.0703.0357-.1207.057-.1362.0007-.0005.0697-.0471.4272.0307a.3673.3673 0 0 0 .0443.0068l.2539.0223.0149.001c.8468.0384 1.9114-.1426 2.5312-.4308.6438-.2988 1.8057-1.0323 1.5951-1.6698zM21.3625 7.16c-.0049.2515-.0399.48-.077.7182-.0399.2563-.0811.5214-.0914.8438-.01.3137.0293.6396.0674.9547.077.6363.1554 1.2929-.1485 1.9411a3.434 3.434 0 0 1-.1342-.2766c-.0378-.0915-.1196-.2387-.2329-.4419-.4413-.7915-1.4747-2.6448-.9457-3.4011.1576-.2253.5577-.2566 1.0029-.1597.0413-.0413.0729-.0784.097-.1117l-.1116-.5081c.5081-.0784 1.0306.0029 1.4661.4067-.083.1313-.2143.4419-.4067.4419zM4.0046 13.149c-.5329-1.746-.8447-3.5021-.8694-3.9944-.0778-1.5567.299-2.6402 1.1199-3.2207 1.3165-.9311 3.4694-.3878 4.379-.0932-.0023.0023-.0047.0044-.007.0067-1.4511 1.4654-1.4167 3.9692-1.4131 4.122-.0001.059.0047.1426.0116.2576.0249.4211.0714 1.2048-.0527 2.0923-.1154.8247.1389 1.6321.6974 2.2148.0578.0603.1181.1169.1804.1701-.2486.2663-.789.8551-1.3641 1.5468-.4069.4892-.6879.3955-.7803.3647-.281-.0937-.5829-.4209-.8877-.9481-.3438-.6014-.6907-1.4564-1.0149-2.5179zm4.3068 3.647c-.1226-.0307-.2345-.0812-.3098-.127.0637-.0283.1701-.0647.3464-.101.92-.1893 1.0621-.3231 1.3724-.7171.0711-.0903.1517-.1927.2633-.3174a.2545.2545 0 0 0 .0528-.0931c.1224-.1085.1953-.0788.3132-.0299.1118.0463.2206.1864.2648.3407.0209.0728.0444.2111-.0324.3186-.6483.9075-1.5926.8957-2.2707.726zm1.5009-2.8593-.0376.1011c-.0954.2556-.184.4933-.239.7191-.4785-.0015-.9441-.2059-1.298-.5752-.4502-.4697-.6547-1.123-.561-1.7926.1311-.9376.0827-1.7541.0567-2.1928-.0036-.0614-.0068-.1152-.0088-.1576.212-.1879 1.1944-.7141 1.8949-.5536.3197.0733.5145.2908.5954.6653.419 1.9387.0555 2.7466-.2368 3.3961-.0602.1338-.1171.2602-.1657.391zm5.2796 3.2784c-.0121.1267-.0257.2696-.0444.4272l-.1047.3143a.2543.2543 0 0 0-.013.0772c-.0042.3403-.0387.4652-.0824.6232-.0455.1643-.097.3506-.1287.7581-.0789 1.0139-.6296 1.5965-1.7329 1.8329-1.0865.2331-1.2792-.3562-1.4491-.876a4.7191 4.7191 0 0 0-.0551-.1625c-.1545-.42-.137-1.0124-.1128-1.832.0118-.4023-.0179-1.363-.2368-1.8971.0032-.2102.0076-.4236.0136-.6394a.253.253 0 0 0-.011-.0807 1.0703 1.0703 0 0 0-.0315-.1491c-.0879-.3071-.302-.564-.5589-.6705-.1021-.0423-.2894-.1199-.5145-.0623.048-.1979.1313-.4212.2215-.6631l.0379-.1018c.0427-.1147.0961-.2335.1527-.3593.3058-.6794.7245-1.6098.27-3.712-.1702-.7873-.7388-1.1717-1.6008-1.0824-.5167.0535-.989.262-1.2249.3815a4.066 4.066 0 0 0-.1404.0746c.0658-.7933.3145-2.2761 1.2444-3.2141a2.8902 2.8902 0 0 1 .2175-.1979.2532.2532 0 0 0 .1037-.0462c.5395-.4091 1.215-.6099 2.0091-.5969.2933.0048.575.0243.8419.0581 1.3902.2541 2.326 1.0374 2.8939 1.7085.5839.69.9001 1.385 1.0263 1.7599-.9488-.0965-1.5942.0909-1.9214.5585-.7117 1.0173.3894 2.9921.9186 3.9411.097.174.1808.3243.2072.3882.1723.4176.3955.6964.5584.9-.026.0083-.0526.0167-.0805.0254z'
		},
		{
			name: 'Redis',
			color: '#ff4438',
			icon: 'M22.71 13.145c-1.66 2.092-3.452 4.483-7.038 4.483-3.203 0-4.397-2.825-4.48-5.12.701 1.484 2.073 2.685 4.214 2.63 4.117-.133 6.94-3.852 6.94-7.239 0-4.05-3.022-6.972-8.268-6.972-3.752 0-8.4 1.428-11.455 3.685C2.59 6.937 3.885 9.958 4.35 9.626c2.648-1.904 4.748-3.13 6.784-3.744C8.12 9.244.886 17.05 0 18.425c.1 1.261 1.66 4.648 2.424 4.648.232 0 .431-.133.664-.365a100.49 100.49 0 0 0 5.54-6.765c.222 3.104 1.748 6.898 6.014 6.898 3.819 0 7.604-2.756 9.33-8.965.2-.764-.73-1.361-1.261-.73zm-4.349-5.013c0 1.959-1.926 2.922-3.685 2.922-.941 0-1.664-.247-2.235-.568 1.051-1.592 2.092-3.225 3.21-4.973 1.972.334 2.71 1.43 2.71 2.619z'
		},
		{
			name: 'Docker',
			color: '#2496ed',
			icon: 'M13.983 11.078h2.119a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.119a.185.185 0 00-.185.185v1.888c0 .102.083.185.185.185m-2.954-5.43h2.118a.186.186 0 00.186-.186V3.574a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185m0 2.716h2.118a.187.187 0 00.186-.186V6.29a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.887c0 .102.082.185.185.186m-2.93 0h2.12a.186.186 0 00.184-.186V6.29a.185.185 0 00-.185-.185H8.1a.185.185 0 00-.185.185v1.887c0 .102.083.185.185.186m-2.964 0h2.119a.186.186 0 00.185-.186V6.29a.185.185 0 00-.185-.185H5.136a.186.186 0 00-.186.185v1.887c0 .102.084.185.186.186m5.893 2.715h2.118a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185m-2.93 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.083.185.185.185m-2.964 0h2.119a.185.185 0 00.185-.185V9.006a.185.185 0 00-.184-.186h-2.12a.186.186 0 00-.186.186v1.887c0 .102.084.185.186.185m-2.92 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.082.185.185.185M23.763 9.89c-.065-.051-.672-.51-1.954-.51-.338.001-.676.03-1.01.087-.248-1.7-1.653-2.53-1.716-2.566l-.344-.199-.226.327c-.284.438-.49.922-.612 1.43-.23.97-.09 1.882.403 2.661-.595.332-1.55.413-1.744.42H.751a.751.751 0 00-.75.748 11.376 11.376 0 00.692 4.062c.545 1.428 1.355 2.48 2.41 3.124 1.18.723 3.1 1.137 5.275 1.137.983.003 1.963-.086 2.93-.266a12.248 12.248 0 003.823-1.389c.98-.567 1.86-1.288 2.61-2.136 1.252-1.418 1.998-2.997 2.553-4.4h.221c1.372 0 2.215-.549 2.68-1.009.309-.293.55-.65.707-1.046l.098-.288Z'
		},
		{
			name: 'Tailwind',
			color: '#38bdf8',
			icon: 'M12.001,4.8c-3.2,0-5.2,1.6-6,4.8c1.2-1.6,2.6-2.2,4.2-1.8c0.913,0.228,1.565,0.89,2.288,1.624 C13.666,10.618,15.027,12,18.001,12c3.2,0,5.2-1.6,6-4.8c-1.2,1.6-2.6,2.2-4.2,1.8c-0.913-0.228-1.565-0.89-2.288-1.624 C16.337,6.182,14.976,4.8,12.001,4.8z M6.001,12c-3.2,0-5.2,1.6-6,4.8c1.2-1.6,2.6-2.2,4.2-1.8c0.913,0.228,1.565,0.89,2.288,1.624 c1.177,1.194,2.538,2.576,5.512,2.576c3.2,0,5.2-1.6,6-4.8c-1.2,1.6-2.6,2.2-4.2,1.8c-0.913-0.228-1.565-0.89-2.288-1.624 C10.337,13.382,8.976,12,6.001,12z'
		}
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
		<a href="/" class="transition-opacity hover:opacity-80">
			<Logo size={26} wordClass="text-xl" />
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

		<div class="mb-6 flex justify-center">
			<Logo size={72} showWord={false} />
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
							class="group inline-flex items-center gap-2 rounded-full border border-neutral-800 bg-neutral-900/50 px-3.5 py-1.5 font-mono text-xs text-neutral-400 transition-colors hover:border-neutral-700 hover:text-neutral-200"
						>
							<svg
								width="14"
								height="14"
								viewBox="0 0 24 24"
								fill={t.color}
								aria-hidden="true"
								class="opacity-80 transition-opacity group-hover:opacity-100"
							>
								<path d={t.icon} />
							</svg>
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
