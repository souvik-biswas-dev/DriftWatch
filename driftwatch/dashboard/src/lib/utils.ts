import type { DriftType, Severity } from './types';

export function timeAgo(iso: string | Date): string {
	const ms = Date.now() - new Date(iso).getTime();
	const sec = Math.floor(ms / 1000);
	if (sec < 5) return 'just now';
	if (sec < 60) return `${sec}s ago`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h ago`;
	const day = Math.floor(hr / 24);
	if (day < 7) return `${day}d ago`;
	return new Date(iso).toLocaleDateString();
}

export function severityColor(sev: Severity): string {
	switch (sev) {
		case 'critical':
			return '#ef4444';
		case 'warning':
			return '#eab308';
		case 'info':
			return '#3b82f6';
		default:
			return '#737373';
	}
}

export function severityBgClass(sev: Severity): string {
	switch (sev) {
		case 'critical':
			return 'bg-red-500/15 text-red-400 border-red-500/30';
		case 'warning':
			return 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30';
		case 'info':
			return 'bg-blue-500/15 text-blue-400 border-blue-500/30';
	}
}

export function driftTypeLabel(t: DriftType): string {
	switch (t) {
		case 'env_mismatch':
			return 'env mismatch';
		case 'image_stale':
			return 'image stale';
		case 'port_changed':
			return 'port changed';
		case 'missing_container':
			return 'missing container';
		case 'extra_container':
			return 'extra container';
	}
}
