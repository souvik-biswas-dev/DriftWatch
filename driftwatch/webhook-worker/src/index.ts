/**
 * DriftWatch GitHub Webhook Worker
 *
 * Receives webhook events from GitHub, verifies the HMAC-SHA256 signature
 * against the configured secret, and forwards push events to the DriftWatch
 * backend with our own shared-secret header. GitHub never blocks on the
 * backend's response — the worker acknowledges the delivery as soon as the
 * signature passes and forwards via ctx.waitUntil.
 *
 * ---
 * Deployment
 * ---
 *   cd webhook-worker
 *   npm install
 *
 *   # Set secrets (production):
 *   wrangler secret put GITHUB_WEBHOOK_SECRET   # the secret you configure on the GitHub repo
 *   wrangler secret put DRIFTWATCH_SECRET       # must match the backend's WEBHOOK_SECRET env var
 *
 *   # BACKEND_URL is non-secret; either set in wrangler.toml [vars] or via
 *   #   wrangler secret put BACKEND_URL
 *   # for per-environment overrides.
 *
 *   wrangler deploy
 *
 * Configure the GitHub webhook (repo → Settings → Webhooks → Add):
 *   Payload URL:   https://driftwatch-webhook.<your-subdomain>.workers.dev/webhook/github
 *   Content type:  application/json
 *   Secret:        <value of GITHUB_WEBHOOK_SECRET>
 *   Events:        Just the push event.
 *
 * Local dev
 * ---
 *   Create .dev.vars in this folder:
 *     GITHUB_WEBHOOK_SECRET="local-test"
 *     DRIFTWATCH_SECRET="local-driftwatch"
 *     BACKEND_URL="http://localhost:8080"
 *
 *   npm run dev
 */

export interface Env {
	GITHUB_WEBHOOK_SECRET: string;
	DRIFTWATCH_SECRET: string;
	BACKEND_URL: string;
}

interface GitHubPushPayload {
	ref?: string;
	after?: string;
	repository?: {
		full_name?: string;
		name?: string;
		owner?: { login?: string; name?: string };
	};
	pusher?: { name?: string };
}

interface ForwardedPayload {
	repo_full_name: string;
	ref: string;
	head_commit_sha: string;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (request.method !== 'POST' || url.pathname !== '/webhook/github') {
			return new Response('Not Found', { status: 404 });
		}

		// 1. Read the raw body once — needed verbatim for HMAC verification.
		const rawBody = await request.text();

		// 2. Verify the signature before doing anything else with the payload.
		const signature = request.headers.get('X-Hub-Signature-256');
		const valid = await verifySignature(env.GITHUB_WEBHOOK_SECRET, rawBody, signature);
		if (!valid) {
			return new Response('invalid signature', { status: 401 });
		}

		// 3. GitHub indicates the event type via header, not the payload body.
		// Non-push events (ping, pull_request, etc.) are acknowledged but ignored.
		const eventType = request.headers.get('X-GitHub-Event');
		if (eventType !== 'push') {
			return new Response(`ignored: event ${eventType}`, { status: 200 });
		}

		// 4. Parse the payload to extract the repo identifier for the backend.
		let payload: GitHubPushPayload;
		try {
			payload = JSON.parse(rawBody) as GitHubPushPayload;
		} catch {
			return new Response('invalid JSON', { status: 400 });
		}

		const repoFullName = payload.repository?.full_name;
		if (!repoFullName) {
			return new Response('missing repository.full_name', { status: 400 });
		}

		const forwarded: ForwardedPayload = {
			repo_full_name: repoFullName,
			ref: payload.ref ?? '',
			head_commit_sha: payload.after ?? ''
		};

		// 5. Acknowledge GitHub immediately. Forwarding runs in the background.
		ctx.waitUntil(forwardToBackend(env, forwarded));

		return new Response('accepted', { status: 200 });
	}
};

async function forwardToBackend(env: Env, payload: ForwardedPayload): Promise<void> {
	try {
		const res = await fetch(`${env.BACKEND_URL}/api/webhook/github`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-DriftWatch-Secret': env.DRIFTWATCH_SECRET
			},
			body: JSON.stringify(payload)
		});
		if (!res.ok) {
			const text = await res.text().catch(() => '');
			console.error('backend rejected webhook', res.status, text);
		}
	} catch (err) {
		console.error('failed to forward webhook', err);
	}
}

/**
 * verifySignature validates a GitHub X-Hub-Signature-256 header against the
 * raw request body using HMAC-SHA256 and a constant-time comparison.
 *
 * Returns false on any structural issue with the header (missing, wrong
 * prefix, wrong length, non-hex) so callers don't need to pre-validate.
 *
 * Exported for unit testing.
 */
export async function verifySignature(
	secret: string,
	body: string,
	header: string | null
): Promise<boolean> {
	if (!secret) return false;
	if (!header) return false;
	if (!header.startsWith('sha256=')) return false;

	const expectedHex = header.slice(7).toLowerCase();
	if (expectedHex.length !== 64) return false; // SHA-256 = 32 bytes = 64 hex chars
	if (!/^[0-9a-f]+$/.test(expectedHex)) return false;

	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);

	const sigBuf = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
	const actualHex = bufferToHex(new Uint8Array(sigBuf));

	return timingSafeEqual(actualHex, expectedHex);
}

function bufferToHex(buf: Uint8Array): string {
	let out = '';
	for (let i = 0; i < buf.length; i++) {
		out += buf[i].toString(16).padStart(2, '0');
	}
	return out;
}

/**
 * timingSafeEqual compares two equal-length strings in constant time
 * relative to their length. Returns false immediately when lengths differ
 * — leaking length is acceptable here since both inputs are fixed-size
 * SHA-256 hex digests (always 64 chars).
 */
function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}
