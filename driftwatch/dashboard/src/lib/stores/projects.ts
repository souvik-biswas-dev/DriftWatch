import { writable } from 'svelte/store';
import { api, ApiClientError } from '$lib/api';
import type { Project } from '$lib/types';

interface ProjectsState {
	items: Project[];
	loading: boolean;
	error: string | null;
}

function createProjectsStore() {
	const { subscribe, set, update } = writable<ProjectsState>({
		items: [],
		loading: false,
		error: null
	});

	return {
		subscribe,
		async load() {
			update((s) => ({ ...s, loading: true, error: null }));
			try {
				const items = await api.listProjects();
				set({ items: items ?? [], loading: false, error: null });
			} catch (e) {
				const msg = e instanceof ApiClientError ? e.message : 'failed to load projects';
				update((s) => ({ ...s, loading: false, error: msg }));
			}
		},
		add(project: Project) {
			update((s) => ({ ...s, items: [project, ...s.items] }));
		},
		remove(id: string) {
			update((s) => ({ ...s, items: s.items.filter((p) => p.id !== id) }));
		},
		clear() {
			set({ items: [], loading: false, error: null });
		}
	};
}

export const projects = createProjectsStore();
