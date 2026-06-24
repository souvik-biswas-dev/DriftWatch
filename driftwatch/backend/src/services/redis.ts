import { Redis } from 'ioredis';

/**
 * Upstash (and any managed Redis) hands out rediss:// URLs; ioredis enables TLS
 * from the scheme automatically.
 */
export function createRedis(redisUrl: string): Redis {
	return new Redis(redisUrl, {
		// Fail a command rather than queueing forever when the connection is
		// down — a scan that can't read cached state should skip, not hang.
		maxRetriesPerRequest: 3,
		connectTimeout: 10_000
	});
}

export type RedisClient = Redis;
