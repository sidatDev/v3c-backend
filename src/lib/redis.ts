import Redis, { RedisOptions } from 'ioredis';

let redisInstance: Redis | null = null;

export const getRedisOptions = (): RedisOptions => {
  return {
    lazyConnect: true,
    maxRetriesPerRequest: null, // Required by BullMQ
    enableReadyCheck: false,
    retryStrategy(times: number) {
      const delay = Math.min(times * 100, 3000);
      console.warn(`[REDIS] Connection lost. Reconnecting attempt #${times} in ${delay}ms...`);
      return delay;
    },
  };
};

/**
 * Returns the shared singleton ioredis client instance.
 */
export const getRedisClient = (): Redis => {
  if (!redisInstance) {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    redisInstance = new Redis(redisUrl, getRedisOptions());

    redisInstance.on('connect', () => {
      console.log(`[REDIS] Successfully connected to Redis at ${redisUrl.replace(/:[^:@]+@/, ':***@')}`);
    });

    redisInstance.on('ready', () => {
      console.log('[REDIS] Client is ready to receive commands');
    });

    redisInstance.on('error', (err: Error) => {
      console.error('[REDIS ERROR] Connection or command error:', {
        message: err.message,
        stack: err.stack,
      });
    });

    redisInstance.on('close', () => {
      console.log('[REDIS] Connection closed');
    });

    redisInstance.on('reconnecting', (time: number) => {
      console.log(`[REDIS] Reconnecting to Redis in ${time}ms`);
    });
  }

  return redisInstance;
};

/**
 * Gracefully close the Redis client connection.
 */
export const closeRedis = async (): Promise<void> => {
  if (redisInstance) {
    console.log('[REDIS] Closing Redis connection...');
    try {
      await redisInstance.quit();
    } catch (err: any) {
      console.warn('[REDIS] Force disconnecting Redis connection:', err.message);
      redisInstance.disconnect();
    } finally {
      redisInstance = null;
    }
  }
};

export default getRedisClient;
