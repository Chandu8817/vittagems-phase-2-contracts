const { getDatabase } = require('./database');

class SettlementRepository {
    constructor(dbClient) {
        this._db = dbClient;
    }

    async getDb() {
        if (this._db) return this._db;
        return await getDatabase();
    }

    /**
     * Create a new settlement record.
     */
    async create(data) {
        const db = await this.getDb();
        const now = new Date().toISOString();

        const sql = `
            INSERT INTO settlements (
                request_id,
                settlement_ref,
                idempotency_key,
                status,
                tx_hash,
                chain_id,
                redeemer,
                amount_burned,
                usdc_paid,
                price_used,
                block_number,
                gas_used,
                error_message,
                on_chain_status,
                reconciled_at,
                created_at,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        const params = [
            data.requestId,
            data.settlementRef,
            data.idempotencyKey || null,
            data.status || 'SUBMITTING',
            data.txHash || null,
            data.chainId || null,
            data.redeemer || null,
            data.amountBurned ? data.amountBurned.toString() : null,
            data.usdcPaid ? data.usdcPaid.toString() : null,
            data.priceUsed ? data.priceUsed.toString() : null,
            data.blockNumber || null,
            data.gasUsed ? data.gasUsed.toString() : null,
            data.errorMessage || null,
            data.onChainStatus || null,
            data.reconciledAt || null,
            now,
            now
        ];

        const res = await db.run(sql, params);
        return await this.findById(res.lastID);
    }

    /**
     * Update an existing settlement record by ID.
     */
    async update(id, fields) {
        const db = await this.getDb();
        const allowed = [
            'status', 'tx_hash', 'chain_id', 'redeemer', 'amount_burned',
            'usdc_paid', 'price_used', 'block_number', 'gas_used',
            'error_message', 'on_chain_status', 'reconciled_at'
        ];

        const setClauses = [];
        const params = [];

        for (const [key, value] of Object.entries(fields)) {
            const snakeKey = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
            if (allowed.includes(snakeKey)) {
                setClauses.push(`${snakeKey} = ?`);
                params.push(value !== undefined && value !== null ? value.toString() : null);
            }
        }

        if (setClauses.length === 0) return await this.findById(id);

        setClauses.push('updated_at = ?');
        params.push(new Date().toISOString());

        params.push(id);
        const sql = `UPDATE settlements SET ${setClauses.join(', ')} WHERE id = ?`;
        await db.run(sql, params);

        return await this.findById(id);
    }

    async findById(id) {
        const db = await this.getDb();
        return await db.get('SELECT * FROM settlements WHERE id = ?', [id]);
    }

    async findByRequestId(requestId) {
        const db = await this.getDb();
        return await db.get('SELECT * FROM settlements WHERE request_id = ? ORDER BY id DESC LIMIT 1', [requestId]);
    }

    async findBySettlementRef(settlementRef) {
        const db = await this.getDb();
        return await db.get('SELECT * FROM settlements WHERE settlement_ref = ?', [settlementRef]);
    }

    async findByIdempotencyKey(key) {
        if (!key) return null;
        const db = await this.getDb();
        return await db.get('SELECT * FROM settlements WHERE idempotency_key = ?', [key]);
    }

    async findByTxHash(txHash) {
        if (!txHash) return null;
        const db = await this.getDb();
        return await db.get('SELECT * FROM settlements WHERE tx_hash = ?', [txHash]);
    }

    /**
     * Look up existing settlement by idempotency key, settlement ref, or request ID.
     */
    async findExisting({ requestId, settlementRef, idempotencyKey }) {
        if (idempotencyKey) {
            const byKey = await this.findByIdempotencyKey(idempotencyKey);
            if (byKey) return byKey;
        }
        if (settlementRef) {
            const byRef = await this.findBySettlementRef(settlementRef);
            if (byRef) return byRef;
        }
        if (requestId) {
            const byReq = await this.findByRequestId(requestId);
            if (byReq) return byReq;
        }
        return null;
    }

    /**
     * List settlements with filtering and pagination.
     */
    async list({ status, requestId, limit = 50, offset = 0 } = {}) {
        const db = await this.getDb();
        const conditions = [];
        const params = [];

        if (status) {
            conditions.push('status = ?');
            params.push(status);
        }
        if (requestId) {
            conditions.push('request_id = ?');
            params.push(requestId);
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const countRow = await db.get(`SELECT COUNT(*) as count FROM settlements ${where}`, params);
        const total = countRow ? countRow.count : 0;

        const safeLimit = Math.min(Math.max(1, limit), 100);
        const safeOffset = Math.max(0, offset);

        const records = await db.all(`
            SELECT * FROM settlements
            ${where}
            ORDER BY id DESC
            LIMIT ? OFFSET ?
        `, [...params, safeLimit, safeOffset]);

        return {
            total,
            limit: safeLimit,
            offset: safeOffset,
            records
        };
    }

    /**
     * Aggregate reconciliation metrics.
     */
    async getSummary() {
        const db = await this.getDb();
        const counts = await db.all(`
            SELECT
                status,
                COUNT(*) as count
            FROM settlements
            GROUP BY status
        `);

        const byStatus = {
            SUBMITTING: 0,
            PENDING: 0,
            CONFIRMED: 0,
            FAILED: 0,
            MISMATCHED: 0
        };

        for (const row of counts) {
            byStatus[row.status] = row.count;
        }

        const countRow = await db.get('SELECT COUNT(*) as count FROM settlements');
        const totalRecords = countRow ? countRow.count : 0;

        const confirmedRows = await db.all(`
            SELECT amount_burned, usdc_paid
            FROM settlements
            WHERE status = 'CONFIRMED'
        `);

        let totalAmountBurnedWei = 0n;
        let totalUsdcPaidUnits = 0n;

        for (const row of confirmedRows) {
            if (row.amount_burned) {
                try {
                    totalAmountBurnedWei += BigInt(row.amount_burned);
                } catch {
                    // ignore malformed
                }
            }
            if (row.usdc_paid) {
                try {
                    totalUsdcPaidUnits += BigInt(row.usdc_paid);
                } catch {
                    // ignore malformed
                }
            }
        }

        return {
            total: totalRecords,
            byStatus,
            confirmedTotals: {
                amountBurnedWei: totalAmountBurnedWei.toString(),
                usdcPaidUnits: totalUsdcPaidUnits.toString()
            }
        };
    }
}

module.exports = new SettlementRepository();
module.exports.SettlementRepository = SettlementRepository;
