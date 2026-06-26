import type { Queryable } from '../db/pool.js';
import type { OAuthConfig } from '../env.js';
import type { GitHubClient } from '../services/github.js';
import type { SchedulerAPI } from '../services/scheduler.js';

/** Everything the HTTP layer needs, assembled once in src/index.ts. */
export interface ApiDeps {
	db: Queryable;
	scheduler: SchedulerAPI;
	github: GitHubClient;
	jwtSecret: string;
	webhookSecret: string;
	oauth: OAuthConfig;
}

declare global {
	// eslint-disable-next-line @typescript-eslint/no-namespace
	namespace Express {
		interface Request {
			/** Set by requireAuth once the bearer token is verified. */
			userId?: string;
		}
	}
}
