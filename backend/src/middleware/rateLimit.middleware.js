/**
 * Simple in-memory rate limiter middleware.
 * @param {object} options { windowMs: number, max: number, message: string }
 */
function createRateLimiter(options = {}) {
    const windowMs = options.windowMs || 60 * 1000; // 1 minute
    const max = options.max || 100;
    const message = options.message || 'Too many requests, please try again later.';

    const hits = new Map();

    // Periodic cleanup of expired entries
    const cleanupInterval = setInterval(() => {
        const now = Date.now();
        for (const [key, record] of hits.entries()) {
            if (now > record.resetTime) {
                hits.delete(key);
            }
        }
    }, windowMs);

    // Unref timer so it doesn't block server shutdown
    if (cleanupInterval.unref) {
        cleanupInterval.unref();
    }

    return (req, res, next) => {
        const ip = req.ip || req.connection.remoteAddress || 'unknown';
        const now = Date.now();

        let record = hits.get(ip);
        if (!record || now > record.resetTime) {
            record = { count: 1, resetTime: now + windowMs };
            hits.set(ip, record);
        } else {
            record.count += 1;
        }

        res.setHeader('X-RateLimit-Limit', max);
        res.setHeader('X-RateLimit-Remaining', Math.max(0, max - record.count));
        res.setHeader('X-RateLimit-Reset', Math.ceil(record.resetTime / 1000));

        if (record.count > max) {
            return res.status(429).json({
                error: {
                    code: 'RATE_LIMIT_EXCEEDED',
                    message,
                    retryAfterSeconds: Math.ceil((record.resetTime - now) / 1000)
                }
            });
        }

        next();
    };
}

module.exports = {
    createRateLimiter
};
