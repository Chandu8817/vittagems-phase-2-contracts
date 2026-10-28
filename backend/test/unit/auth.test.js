const test = require('node:test');
const assert = require('node:assert');
const { requireSettlementAuth } = require('../../src/middleware/auth.middleware');
const config = require('../../src/config/config');

test('Settlement Auth Middleware', async (t) => {
    const originalApiKey = config.SETTLEMENT_API_KEY;

    t.after(() => {
        config.SETTLEMENT_API_KEY = originalApiKey;
    });

    await t.test('returns 503 if SETTLEMENT_API_KEY is not configured', () => {
        config.SETTLEMENT_API_KEY = null;

        const req = { headers: {} };
        let statusCode = null;
        let responseJson = null;

        const res = {
            status: (code) => {
                statusCode = code;
                return {
                    json: (data) => { responseJson = data; }
                };
            }
        };

        let nextCalled = false;
        requireSettlementAuth(req, res, () => { nextCalled = true; });

        assert.strictEqual(statusCode, 503);
        assert.strictEqual(responseJson.error.code, 'SETTLEMENT_DISABLED');
        assert.strictEqual(nextCalled, false);
    });

    await t.test('returns 401 if API key header is missing', () => {
        config.SETTLEMENT_API_KEY = 'valid-test-key';

        const req = { headers: {} };
        let statusCode = null;
        let responseJson = null;

        const res = {
            status: (code) => {
                statusCode = code;
                return {
                    json: (data) => { responseJson = data; }
                };
            }
        };

        let nextCalled = false;
        requireSettlementAuth(req, res, () => { nextCalled = true; });

        assert.strictEqual(statusCode, 401);
        assert.strictEqual(responseJson.error.code, 'UNAUTHORIZED');
        assert.strictEqual(nextCalled, false);
    });

    await t.test('returns 403 if API key header is invalid', () => {
        config.SETTLEMENT_API_KEY = 'valid-test-key';

        const req = { headers: { 'x-api-key': 'wrong-key' } };
        let statusCode = null;
        let responseJson = null;

        const res = {
            status: (code) => {
                statusCode = code;
                return {
                    json: (data) => { responseJson = data; }
                };
            }
        };

        let nextCalled = false;
        requireSettlementAuth(req, res, () => { nextCalled = true; });

        assert.strictEqual(statusCode, 403);
        assert.strictEqual(responseJson.error.code, 'FORBIDDEN');
        assert.strictEqual(nextCalled, false);
    });

    await t.test('allows request with valid x-api-key header', () => {
        config.SETTLEMENT_API_KEY = 'valid-test-key';

        const req = { headers: { 'x-api-key': 'valid-test-key' } };
        const res = {};
        let nextCalled = false;

        requireSettlementAuth(req, res, () => { nextCalled = true; });
        assert.strictEqual(nextCalled, true);
    });

    await t.test('allows request with valid Authorization Bearer header', () => {
        config.SETTLEMENT_API_KEY = 'valid-test-key';

        const req = { headers: { authorization: 'Bearer valid-test-key' } };
        const res = {};
        let nextCalled = false;

        requireSettlementAuth(req, res, () => { nextCalled = true; });
        assert.strictEqual(nextCalled, true);
    });
});
