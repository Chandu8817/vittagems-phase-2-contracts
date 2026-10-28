const dotenv = require('dotenv');
const path = require('path');
const { ethers } = require('ethers');

// Load environment variables: root .env fallback first, then backend .env overrides
dotenv.config({ path: path.join(__dirname, '../../../.env') });
dotenv.config({ path: path.join(__dirname, '../../.env') });

const rawChainId = process.env.CHAIN_ID;
const parsedChainId = rawChainId !== undefined && rawChainId !== '' ? parseInt(rawChainId, 10) : undefined;

const config = {
    PORT: parseInt(process.env.PORT || '3001', 10),
    NODE_ENV: process.env.NODE_ENV || 'development',
    RPC_URL: process.env.RPC_URL || 'http://127.0.0.1:8545',
    CHAIN_ID: Number.isInteger(parsedChainId) ? parsedChainId : undefined,
    // Settlement signer key: prefer dedicated key, fallback to PRIVATE_KEY
    SETTLEMENT_SIGNER_KEY: process.env.SETTLEMENT_SIGNER_KEY || process.env.PRIVATE_KEY || null,
    SETTLEMENT_API_KEY: process.env.SETTLEMENT_API_KEY || null,
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()) : ['*'],
    DB_PATH: process.env.DB_PATH || path.join(__dirname, '../../data/vittagems.db'),
    CONFIRMATIONS: parseInt(process.env.CONFIRMATIONS || '1', 10),
    CONTRACTS: {
        VITA_STABLECOIN: process.env.VITA_STABLECOIN_ADDRESS || null,
        COLLATERAL_CONTROLLER: process.env.COLLATERAL_CONTROLLER_ADDRESS || null,
        REDEMPTION_MODULE: process.env.REDEMPTION_MODULE_ADDRESS || null,
        RESERVE_MANAGER: process.env.RESERVE_MANAGER_ADDRESS || null,
        ASSET_REGISTRY: process.env.ASSET_REGISTRY_ADDRESS || null,
    }
};

/**
 * Validate configuration values.
 * @param {object} cfg Optional config override
 * @param {object} options Validation options (e.g. requireSigner, requireContracts)
 * @returns {{ isValid: boolean, errors: string[], warnings: string[] }}
 */
function validateConfig(cfg = config, options = {}) {
    const errors = [];
    const warnings = [];

    // RPC_URL check
    if (!cfg.RPC_URL) {
        errors.push('RPC_URL is required but not configured.');
    } else {
        try {
            new URL(cfg.RPC_URL);
        } catch {
            errors.push(`Invalid RPC_URL format: "${cfg.RPC_URL}". Must be a valid URL.`);
        }
    }

    // Chain ID check
    if (cfg.CHAIN_ID !== undefined && (!Number.isInteger(cfg.CHAIN_ID) || cfg.CHAIN_ID <= 0)) {
        errors.push(`Invalid CHAIN_ID: "${cfg.CHAIN_ID}". Must be a positive integer.`);
    }

    // Settlement signer key check
    if (cfg.SETTLEMENT_SIGNER_KEY) {
        try {
            new ethers.Wallet(cfg.SETTLEMENT_SIGNER_KEY);
        } catch {
            errors.push('Invalid SETTLEMENT_SIGNER_KEY. Must be a valid 32-byte hex private key.');
        }
    } else if (options.requireSigner) {
        errors.push('SETTLEMENT_SIGNER_KEY is required for settlement operations.');
    } else {
        warnings.push('SETTLEMENT_SIGNER_KEY is not configured. Read-only endpoints will work, but settlements will be unavailable.');
    }

    // Settlement API Key check
    if (!cfg.SETTLEMENT_API_KEY) {
        warnings.push('SETTLEMENT_API_KEY is not configured. Sensitive settlement-triggering endpoints should be protected.');
    }

    // Contract addresses check
    const contractNames = [
        ['VITA_STABLECOIN', cfg.CONTRACTS.VITA_STABLECOIN],
        ['COLLATERAL_CONTROLLER', cfg.CONTRACTS.COLLATERAL_CONTROLLER],
        ['REDEMPTION_MODULE', cfg.CONTRACTS.REDEMPTION_MODULE],
        ['RESERVE_MANAGER', cfg.CONTRACTS.RESERVE_MANAGER],
        ['ASSET_REGISTRY', cfg.CONTRACTS.ASSET_REGISTRY]
    ];

    for (const [name, address] of contractNames) {
        if (!address) {
            if (options.requireContracts) {
                errors.push(`Missing contract address for ${name}.`);
            } else {
                warnings.push(`Contract address for ${name} is not set.`);
            }
        } else if (!ethers.isAddress(address)) {
            errors.push(`Invalid Ethereum address for ${name}: "${address}".`);
        }
    }

    // Confirmations check
    if (!Number.isInteger(cfg.CONFIRMATIONS) || cfg.CONFIRMATIONS < 0) {
        errors.push(`Invalid CONFIRMATIONS: "${cfg.CONFIRMATIONS}". Must be a non-negative integer.`);
    }

    return {
        isValid: errors.length === 0,
        errors,
        warnings
    };
}

/**
 * Return sanitized config for health / info responses without leaking secrets.
 */
function getSanitizedConfig(cfg = config) {
    let signerAddress = null;
    if (cfg.SETTLEMENT_SIGNER_KEY) {
        try {
            const wallet = new ethers.Wallet(cfg.SETTLEMENT_SIGNER_KEY);
            signerAddress = wallet.address;
        } catch {
            signerAddress = 'INVALID_KEY';
        }
    }

    return {
        port: cfg.PORT,
        nodeEnv: cfg.NODE_ENV,
        rpcUrl: cfg.RPC_URL,
        chainId: cfg.CHAIN_ID,
        signerConfigured: Boolean(cfg.SETTLEMENT_SIGNER_KEY),
        signerAddress,
        apiKeyConfigured: Boolean(cfg.SETTLEMENT_API_KEY),
        allowedOrigins: cfg.ALLOWED_ORIGINS,
        confirmations: cfg.CONFIRMATIONS,
        contracts: { ...cfg.CONTRACTS }
    };
}

module.exports = {
    ...config,
    validateConfig,
    getSanitizedConfig
};
