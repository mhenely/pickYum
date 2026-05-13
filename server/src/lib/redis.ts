import IORedis from 'ioredis';
import { logger } from './logger';

// Shared Redis client. Null when REDIS_URL is not set (dev / single-instance).
// Both sessions.ts and places.ts import this to avoid opening two connections.
const redis = process.env.REDIS_URL
  ? new IORedis(process.env.REDIS_URL, { lazyConnect: true, enableOfflineQueue: false })
  : null;

if (redis) {
  redis.connect().catch((err) => {
    logger.error({ err }, 'Redis connection failed — in-memory fallback active');
  });
}

export default redis;
