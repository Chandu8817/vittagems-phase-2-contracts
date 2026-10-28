const cors = require('cors');
const config = require('../config/config');

function getCorsMiddleware() {
    const allowed = config.ALLOWED_ORIGINS;

    // If wildcard is included, allow all
    if (allowed.includes('*')) {
        return cors();
    }

    return cors({
        origin: function (origin, callback) {
            // Allow requests with no origin (like mobile apps, curl, server-to-server)
            if (!origin) return callback(null, true);
            if (allowed.indexOf(origin) !== -1) {
                return callback(null, true);
            }
            return callback(new Error(`CORS policy: origin ${origin} is not allowed.`));
        },
        credentials: true
    });
}

module.exports = getCorsMiddleware;
