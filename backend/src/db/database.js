const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const config = require('../config/config');

let dbInstance = null;
let initPromise = null;

class DatabaseClient {
    constructor(db) {
        this.db = db;
    }

    run(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function (err) {
                if (err) return reject(err);
                resolve({ lastID: this.lastID, changes: this.changes });
            });
        });
    }

    get(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.get(sql, params, (err, row) => {
                if (err) return reject(err);
                resolve(row || null);
            });
        });
    }

    all(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) return reject(err);
                resolve(rows || []);
            });
        });
    }

    exec(sql) {
        return new Promise((resolve, reject) => {
            this.db.exec(sql, (err) => {
                if (err) return reject(err);
                resolve();
            });
        });
    }

    close() {
        return new Promise((resolve, reject) => {
            this.db.close((err) => {
                if (err) return reject(err);
                resolve();
            });
        });
    }
}

/**
 * Initialize or get database client.
 * @param {string} customPath Optional custom path (e.g. ':memory:')
 * @returns {Promise<DatabaseClient>}
 */
async function getDatabase(customPath) {
    if (dbInstance && !customPath) {
        return dbInstance;
    }

    const dbPath = customPath || config.DB_PATH;

    if (dbPath !== ':memory:') {
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    const db = await new Promise((resolve, reject) => {
        const d = new sqlite3.Database(dbPath, (err) => {
            if (err) return reject(err);
            resolve(d);
        });
    });

    const client = new DatabaseClient(db);
    await runMigrations(client);

    if (!customPath) {
        dbInstance = client;
    }

    return client;
}

/**
 * Run schema migrations on the database client.
 * @param {DatabaseClient} client
 */
async function runMigrations(client) {
    await client.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS settlements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            request_id INTEGER NOT NULL,
            settlement_ref TEXT NOT NULL UNIQUE,
            idempotency_key TEXT UNIQUE,
            status TEXT NOT NULL CHECK(status IN ('SUBMITTING', 'PENDING', 'CONFIRMED', 'FAILED', 'MISMATCHED')),
            tx_hash TEXT,
            chain_id INTEGER,
            redeemer TEXT,
            amount_burned TEXT,
            usdc_paid TEXT,
            price_used TEXT,
            block_number INTEGER,
            gas_used TEXT,
            error_message TEXT,
            on_chain_status TEXT,
            reconciled_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_settlements_request_id ON settlements(request_id);
        CREATE INDEX IF NOT EXISTS idx_settlements_status ON settlements(status);
        CREATE INDEX IF NOT EXISTS idx_settlements_tx_hash ON settlements(tx_hash);
        CREATE INDEX IF NOT EXISTS idx_settlements_settlement_ref ON settlements(settlement_ref);
    `);
}

/**
 * Close the singleton database connection.
 */
async function closeDatabase() {
    if (dbInstance) {
        try {
            await dbInstance.close();
        } catch (err) {
            console.error('Error closing database:', err.message);
        }
        dbInstance = null;
    }
}

module.exports = {
    getDatabase,
    runMigrations,
    closeDatabase,
    DatabaseClient
};
