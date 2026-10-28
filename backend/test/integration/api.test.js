const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../../src/app');
const config = require('../../src/config/config');

test('Backend API Endpoints Integration', async (t) => {
    const validApiKey = 'test-api-key-12345';
    const originalKey = config.SETTLEMENT_API_KEY;

    t.before(() => {
        config.SETTLEMENT_API_KEY = validApiKey;
    });

    t.after(() => {
        config.SETTLEMENT_API_KEY = originalKey;
    });

    await t.test('GET /health returns health response and sanitized config', async () => {
        const res = await request(app).get('/health');
        // Status code is 200 if connected, 503 if provider offline
        assert.ok([200, 503].includes(res.status));
        assert.ok(res.body.status);
        assert.ok(res.body.timestamp);
        assert.ok(res.body.config);
        assert.strictEqual(res.body.config.SETTLEMENT_SIGNER_KEY, undefined);
        assert.strictEqual(res.body.config.SETTLEMENT_API_KEY, undefined);
    });

    await t.test('GET /api/contracts/info returns contract deployment mapping', async () => {
        const res = await request(app).get('/api/contracts/info');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.status, 'Connected');
        assert.ok(res.body.contracts);
        assert.ok('vittaStablecoin' in res.body.contracts);
        assert.ok('collateralController' in res.body.contracts);
        assert.ok('redemptionModule' in res.body.contracts);
        assert.ok('reserveManager' in res.body.contracts);
        assert.ok('assetRegistry' in res.body.contracts);
    });

    await t.test('GET /api/rwa/assets and /api/assets return 200 or 503', async () => {
        const resRwa = await request(app).get('/api/rwa/assets');
        assert.ok([200, 503].includes(resRwa.status));
        if (resRwa.status === 200) {
            assert.strictEqual(resRwa.body.success, true);
            assert.ok(Array.isArray(resRwa.body.assets));
            assert.ok(resRwa.body.statusCounts);
        }

        const resAlias = await request(app).get('/api/assets');
        assert.ok([200, 503].includes(resAlias.status));
    });

    await t.test('GET /api/rwa/summary returns registry overview or 503', async () => {
        const res = await request(app).get('/api/rwa/summary');
        assert.ok([200, 503].includes(res.status));
        if (res.status === 200) {
            assert.strictEqual(res.body.success, true);
            assert.ok(res.body.summary);
            assert.ok('totalAssets' in res.body.summary);
        }
    });

    await t.test('GET /api/rwa/assets/:id rejects invalid asset ID format with 400', async () => {
        const res = await request(app).get('/api/rwa/assets/not-a-number');
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.error.code, 'INVALID_ASSET_ID');
    });

    await t.test('GET /api/reconciliation/status returns reconciliation metrics', async () => {
        const res = await request(app).get('/api/reconciliation/status');
        assert.strictEqual(res.status, 200);
        assert.ok('total' in res.body);
        assert.ok('byStatus' in res.body);
        assert.ok('treasuryNotice' in res.body);
        assert.ok(res.body.treasuryNotice.includes('Treasury'));
    });

    await t.test('GET /api/reconciliation/records returns paginated records', async () => {
        const res = await request(app).get('/api/reconciliation/records');
        assert.strictEqual(res.status, 200);
        assert.ok(Array.isArray(res.body.records));
        assert.ok('total' in res.body);
    });

    await t.test('POST /api/settlement/settle enforces authentication', async () => {
        // Missing auth
        const resNoAuth = await request(app)
            .post('/api/settlement/settle')
            .send({ requestId: 1 });

        assert.strictEqual(resNoAuth.status, 401);
        assert.strictEqual(resNoAuth.body.error.code, 'UNAUTHORIZED');

        // Invalid auth
        const resWrongAuth = await request(app)
            .post('/api/settlement/settle')
            .set('x-api-key', 'wrong-key')
            .send({ requestId: 1 });

        assert.strictEqual(resWrongAuth.status, 403);
        assert.strictEqual(resWrongAuth.body.error.code, 'FORBIDDEN');
    });

    await t.test('POST /api/settlement/settle rejects missing requestId', async () => {
        const res = await request(app)
            .post('/api/settlement/settle')
            .set('x-api-key', validApiKey)
            .send({});

        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.error.code, 'MISSING_REQUEST_ID');
    });

    await t.test('POST /api/reconciliation/reconcile enforces authentication', async () => {
        const resNoAuth = await request(app)
            .post('/api/reconciliation/reconcile')
            .send({});

        assert.strictEqual(resNoAuth.status, 401);
    });

    await t.test('Returns 404 for unknown route', async () => {
        const res = await request(app).get('/api/non-existent-endpoint');
        assert.strictEqual(res.status, 404);
        assert.strictEqual(res.body.error.code, 'NOT_FOUND');
    });
});
