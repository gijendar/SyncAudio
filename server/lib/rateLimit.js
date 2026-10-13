import { limits } from '../config.js';

const buckets = new Map();

/**
 * Very small in-memory sliding-window rate limiter.
 * Good enough to stop casual room/participant abuse on a single instance.
 * Swap for a Redis/Upstash implementation if you run multiple server nodes.
 */
export function rateLimit(scope, key) {
  const rule = limits.rateLimits[scope];
  if (!rule) return { allowed: true };

  const id = `${scope}:${key}`;
  const now = Date.now();
  const hits = (buckets.get(id) || []).filter((ts) => now - ts < rule.windowMs);

  if (hits.length >= rule.max) {
    buckets.set(id, hits);
    return {
      allowed: false,
      retryAfterMs: rule.windowMs - (now - hits[0]),
    };
  }

  hits.push(now);
  buckets.set(id, hits);
  return { allowed: true };
}

/** Periodically drop empty buckets so long-running servers don't leak memory. */
export function startRateLimitSweeper(intervalMs = 5 * 60 * 1000) {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [id, hits] of buckets) {
      const scope = id.split(':')[0];
      const rule = limits.rateLimits[scope];
      const kept = hits.filter((ts) => now - ts < (rule?.windowMs ?? 60000));
      if (kept.length === 0) buckets.delete(id);
      else buckets.set(id, kept);
    }
  }, intervalMs);
  timer.unref?.();
  return timer;
}

/** Normalise an IP for rate-limit keys (handles IPv6 mapped IPv4 + proxies). */
export function clientKey(socketOrReq) {
  const forwarded = socketOrReq?.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  const ip = socketOrReq?.handshake?.address || socketOrReq?.ip || 'unknown';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}
