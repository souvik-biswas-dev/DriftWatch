import type {
	Project,
	DriftEvent,
	User,
	CreateProjectInput,
	LoginResponse,
	ProjectDetail,
	ApiSuccess,
	ApiError
} from './types';

const BASE: string =
	(typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_BASE_URL) ||
	'http://localhost:8080';

const TOKEN_KEY = 'driftwatch_token';

function getToken(): string | null {
	if (typeof localStorage === 'undefined') return null;
	return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
	localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
	localStorage.removeItem(TOKEN_KEY);
}

export class ApiClientError extends Error {
	code: string;
	status: number;
	constructor(message: string, code: string, status: number) {
		super(message);
		this.name = 'ApiClientError';
		this.code = code;
		this.status = status;
	}
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
	const headers = new Headers(init.headers);
	if (!headers.has('Content-Type') && init.body) {
		headers.set('Content-Type', 'application/json');
	}
	const token = getToken();
	if (token) headers.set('Authorization', `Bearer ${token}`);

	const res = await fetch(`${BASE}${path}`, { ...init, headers });

	let body: unknown = null;
	const text = await res.text();
	if (text) {
		try {
			body = JSON.parse(text);
		} catch {
			body = { error: text };
		}
	}

	if (!res.ok) {
		const err = (body as ApiError) ?? { error: 'request failed', code: 'UNKNOWN' };
		// A 401 on an authenticated request means the token is stale or
		// revoked. Drop it so the dashboard auth guard bounces to /login
		// on the next route change.
		if (res.status === 401 && typeof localStorage !== 'undefined') {
			localStorage.removeItem(TOKEN_KEY);
		}
		throw new ApiClientError(
			err.error ?? `request failed with ${res.status}`,
			err.code ?? 'UNKNOWN',
			res.status
		);
	}

	return ((body as ApiSuccess<T>) ?? { data: null as T }).data;
}

export const api = {
	register: (email: string, password: string) =>
		request<User>('/api/auth/register', {
			method: 'POST',
			body: JSON.stringify({ email, password })
		}),
	login: (email: string, password: string) =>
		request<LoginResponse>('/api/auth/login', {
			method: 'POST',
			body: JSON.stringify({ email, password })
		}),

	listProjects: () => request<Project[]>('/api/projects'),
	getProject: (id: string) => request<ProjectDetail>(`/api/projects/${id}`),
	createProject: (input: CreateProjectInput) =>
		request<Project>('/api/projects', {
			method: 'POST',
			body: JSON.stringify(input)
		}),
	deleteProject: (id: string) =>
		request<null>(`/api/projects/${id}`, { method: 'DELETE' }),

	listDrifts: (projectId: string) =>
		request<DriftEvent[]>(`/api/projects/${projectId}/drifts`),
	getDrift: (projectId: string, driftId: string) =>
		request<DriftEvent>(`/api/projects/${projectId}/drifts/${driftId}`),
	resolveDrift: (projectId: string, driftId: string) =>
		request<null>(`/api/projects/${projectId}/drifts/${driftId}/resolve`, {
			method: 'POST'
		})
};
