const app = require('./app');
const config = require('./config/config');
const { validateConfig, getSanitizedConfig } = require('./config/config');
const { getDatabase, closeDatabase } = require('./db/database');
const { verifyConnectivity } = require('./services/blockchain.service');

async function startServer() {
    console.log('----------------------------------------------------');
    console.log('💎 VittaGems Backend API - Initializing...');
    console.log('----------------------------------------------------');

    // 1. Validate configuration
    const validation = validateConfig();
    if (validation.warnings.length > 0) {
        console.warn('⚠️  Configuration Warnings:');
        validation.warnings.forEach(w => console.warn(`   - ${w}`));
    }

    if (!validation.isValid) {
        console.error('❌ Configuration Validation Failed:');
        validation.errors.forEach(e => console.error(`   - ${e}`));
        if (config.NODE_ENV === 'production') {
            process.exit(1);
        }
    }

    // 2. Initialize persistent storage (SQLite)
    try {
        getDatabase();
        console.log(`📦 Persistent database initialized at: ${config.DB_PATH}`);
    } catch (err) {
        console.error('❌ Failed to initialize database:', err.message);
        process.exit(1);
    }

    // 3. Verify blockchain connectivity
    try {
        console.log(`🔗 Verifying connection to RPC: ${config.RPC_URL}`);
        const connectivity = await verifyConnectivity();
        if (connectivity.connected) {
            console.log(`✅ Connected to Chain ID ${connectivity.network.chainId} (block #${connectivity.currentBlock})`);
            if (connectivity.network.chainIdMismatch) {
                console.warn(`⚠️  Chain ID mismatch: configured ${connectivity.network.expectedChainId}, connected to ${connectivity.network.chainId}`);
            }

            // Report contract status
            console.log('📜 Contract Deployment Status:');
            for (const [name, status] of Object.entries(connectivity.contracts)) {
                if (status.deployed) {
                    console.log(`   - ${name}: Deployed at ${status.address}`);
                } else if (status.configured) {
                    console.warn(`   - ${name}: Configured (${status.address}) but NO BYTECODE found on-chain!`);
                } else {
                    console.warn(`   - ${name}: Not configured`);
                }
            }

            // Report signer status
            if (connectivity.signer) {
                console.log(`🔑 Settlement Signer: ${connectivity.signer.address} (Balance: ${connectivity.signer.balanceEth} ETH)`);
                if (connectivity.signer.hasSettlerRole === true) {
                    console.log('   - Holds SETTLER_ROLE on RedemptionModule: Yes');
                } else if (connectivity.signer.hasSettlerRole === false) {
                    console.warn('   - Holds SETTLER_ROLE on RedemptionModule: NO! (Settlements will revert unless granted)');
                }
            } else {
                console.warn('⚠️  No settlement signer configured. Read-only endpoints active.');
            }
        } else {
            console.warn(`⚠️  Blockchain RPC connectivity check failed: ${connectivity.error}`);
            console.warn('   The server will start, but blockchain-dependent endpoints will return errors until RPC is reachable.');
        }
    } catch (err) {
        console.warn(`⚠️  Unexpected error during connectivity check: ${err.message}`);
    }

    // 4. Start HTTP server
    const PORT = config.PORT;
    const server = app.listen(PORT, () => {
        console.log('----------------------------------------------------');
        console.log(`🚀 VittaGems Backend running on http://127.0.0.1:${PORT}`);
        console.log(`   Health check: http://127.0.0.1:${PORT}/health`);
        console.log(`   Analytics:    http://127.0.0.1:${PORT}/api/analytics/overview`);
        console.log(`   Settlement:   http://127.0.0.1:${PORT}/api/settlement/redemptions`);
        console.log('----------------------------------------------------');
    });

    // 5. Graceful shutdown
    const shutdown = (signal) => {
        console.log(`\n🛑 Received ${signal}. Gracefully shutting down...`);
        server.close(() => {
            console.log('🔌 HTTP server closed.');
            closeDatabase();
            console.log('📦 Database connection closed.');
            process.exit(0);
        });

        // Force shutdown after 10 seconds
        setTimeout(() => {
            console.error('⏰ Shutdown timeout. Forcing exit.');
            process.exit(1);
        }, 10000).unref();
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    process.on('unhandledRejection', (reason, promise) => {
        console.error('Unhandled Promise Rejection:', reason);
    });

    process.on('uncaughtException', (err) => {
        console.error('Uncaught Exception:', err);
    });

    return server;
}

if (require.main === module) {
    startServer().catch(err => {
        console.error('Fatal startup error:', err);
        process.exit(1);
    });
}

module.exports = { startServer };
