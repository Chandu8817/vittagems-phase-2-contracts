const { ethers } = require('ethers');
const { getDatabase } = require('../../src/db/database');
const { SettlementRepository } = require('../../src/db/settlementRepository');

/**
 * Create an isolated in-memory database and repository for testing.
 */
async function createTestRepository() {
    const db = await getDatabase(':memory:');
    const repo = new SettlementRepository(db);
    return { db, repo };
}

/**
 * Mock ethers contract generator.
 */
function createMockContract(methods = {}) {
    return {
        ...methods,
        interface: {
            parseLog: (log) => log
        }
    };
}

module.exports = {
    createTestRepository,
    createMockContract
};
