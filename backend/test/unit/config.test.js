const test = require('node:test');
const assert = require('node:assert');
const { validateConfig, getSanitizedConfig } = require('../../src/config/config');

test('Configuration validation', async (t) => {
    await t.test('passes for valid configuration', () => {
        const validConfig = {
            PORT: 3001,
            RPC_URL: 'http://127.0.0.1:8545',
            CHAIN_ID: 31337,
            SETTLEMENT_SIGNER_KEY: '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356',
            SETTLEMENT_API_KEY: 'secret-key-123',
            ALLOWED_ORIGINS: ['*'],
            CONFIRMATIONS: 1,
            CONTRACTS: {
                VITA_STABLECOIN: '0x0b306bf915c4d645ff596e518faf3f9669b97016',
                COLLATERAL_CONTROLLER: '0x959922be3caee4b8cd9a407cc3ac1c251c2007b1',
                REDEMPTION_MODULE: '0x68b1d87f95878fe05b998f19b66f4baba5de1aed',
                RESERVE_MANAGER: '0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0'
            }
        };

        const result = validateConfig(validConfig);
        assert.strictEqual(result.isValid, true);
        assert.strictEqual(result.errors.length, 0);
    });

    await t.test('detects invalid RPC URL', () => {
        const invalidConfig = {
            RPC_URL: 'not-a-valid-url',
            CONTRACTS: {}
        };

        const result = validateConfig(invalidConfig);
        assert.strictEqual(result.isValid, false);
        assert.ok(result.errors.some(e => e.includes('Invalid RPC_URL')));
    });

    await t.test('detects invalid Ethereum contract addresses', () => {
        const invalidConfig = {
            RPC_URL: 'http://127.0.0.1:8545',
            CONTRACTS: {
                VITA_STABLECOIN: '0xInvalidAddress123',
                COLLATERAL_CONTROLLER: '0x123'
            }
        };

        const result = validateConfig(invalidConfig);
        assert.strictEqual(result.isValid, false);
        assert.ok(result.errors.some(e => e.includes('Invalid Ethereum address for VITA_STABLECOIN')));
        assert.ok(result.errors.some(e => e.includes('Invalid Ethereum address for COLLATERAL_CONTROLLER')));
    });

    await t.test('detects invalid private key', () => {
        const invalidConfig = {
            RPC_URL: 'http://127.0.0.1:8545',
            SETTLEMENT_SIGNER_KEY: 'invalid-hex-key',
            CONTRACTS: {}
        };

        const result = validateConfig(invalidConfig);
        assert.strictEqual(result.isValid, false);
        assert.ok(result.errors.some(e => e.includes('Invalid SETTLEMENT_SIGNER_KEY')));
    });

    await t.test('sanitizes config and never leaks private key', () => {
        const testConfig = {
            PORT: 3001,
            NODE_ENV: 'test',
            RPC_URL: 'http://127.0.0.1:8545',
            CHAIN_ID: 31337,
            SETTLEMENT_SIGNER_KEY: '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356',
            SETTLEMENT_API_KEY: 'super-secret-key-123',
            ALLOWED_ORIGINS: ['http://localhost:5173'],
            CONFIRMATIONS: 1,
            CONTRACTS: {
                VITA_STABLECOIN: '0x0b306bf915c4d645ff596e518faf3f9669b97016'
            }
        };

        const sanitized = getSanitizedConfig(testConfig);
        assert.strictEqual(sanitized.signerConfigured, true);
        assert.strictEqual(sanitized.signerAddress, '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955');
        assert.strictEqual(sanitized.apiKeyConfigured, true);
        assert.strictEqual(sanitized.SETTLEMENT_SIGNER_KEY, undefined);
        assert.strictEqual(sanitized.SETTLEMENT_API_KEY, undefined);
        assert.strictEqual(sanitized.PRIVATE_KEY, undefined);
    });
});
