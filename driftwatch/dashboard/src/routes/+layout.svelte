<script lang="ts">
	import '../app.css';
	import { Toaster } from 'svelte-sonner';
</script>

<Toaster
	richColors
	theme="dark"
	position="bottom-right"
	toastOptions={{
		style: 'background: #141414; border: 1px solid #2a2a2a; color: #e5e5e5;'
	}}
/>

<slot />
