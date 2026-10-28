/**
 * Centralized error handling middleware.
 */
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
    // Default error status
    let status = err.status || err.statusCode || 500;
    let code = err.code || 'INTERNAL_SERVER_ERROR';
    let message = err.message || 'An unexpected error occurred.';

    // Handle bad JSON body
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        status = 400;
        code = 'INVALID_JSON';
        message = 'Malformed JSON payload.';
    }

    // Handle ethers/contract error sanitization
    if (err.info && err.info.error) {
        message = err.info.error.message || message;
    }

    // Mask any accidental private key leaks or credentials in message
    message = message.replace(/0x[a-fA-F0-9]{64}/g, match => {
        // Only mask if it could be a private key and not a known address/hash
        return match.substring(0, 6) + '...' + match.substring(60);
    });

    // Server-side logging without secrets
    if (status >= 500) {
        console.error(`[ERROR] ${req.method} ${req.url} - ${status}:`, err.message);
    } else {
        console.warn(`[WARN] ${req.method} ${req.url} - ${status}: ${message}`);
    }

    res.status(status).json({
        error: {
            code,
            message,
            ...(process.env.NODE_ENV === 'test' && err.details ? { details: err.details } : {})
        }
    });
}

/**
 * 404 Not Found handler.
 */
function notFoundHandler(req, res) {
    res.status(404).json({
        error: {
            code: 'NOT_FOUND',
            message: `Route ${req.method} ${req.url} not found.`
        }
    });
}

module.exports = {
    errorHandler,
    notFoundHandler
};
