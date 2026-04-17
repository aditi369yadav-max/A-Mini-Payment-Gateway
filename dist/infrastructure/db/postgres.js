"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.closePool = exports.queryOne = exports.query = exports.withTransaction = exports.getPool = void 0;
const pg_1 = require("pg");
const config_1 = require("../../config");
const logger_1 = require("../../utils/logger");
let pool = null;
const getPool = () => {
    if (!pool) {
        pool = new pg_1.Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.NODE_ENV === 'production'
                ? { rejectUnauthorized: false }
                : false,
            min: config_1.config.db.pool.min,
            max: config_1.config.db.pool.max,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 5000,
        });
        pool.on('connect', () => logger_1.logger.debug('PostgreSQL: new connection acquired'));
        pool.on('error', (err) => logger_1.logger.error('PostgreSQL pool error', { error: err.message }));
    }
    return pool;
};
exports.getPool = getPool;
const withTransaction = async (callback) => {
    const client = await (0, exports.getPool)().connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    }
    catch (error) {
        await client.query('ROLLBACK');
        logger_1.logger.error('DB transaction rolled back', {
            error: error instanceof Error ? error.message : String(error),
        });
        throw error;
    }
    finally {
        client.release();
    }
};
exports.withTransaction = withTransaction;
const query = async (sql, params) => {
    const result = await (0, exports.getPool)().query(sql, params);
    return result.rows;
};
exports.query = query;
const queryOne = async (sql, params) => {
    const rows = await (0, exports.query)(sql, params);
    return rows[0] ?? null;
};
exports.queryOne = queryOne;
const closePool = async () => {
    if (pool) {
        await pool.end();
        pool = null;
        logger_1.logger.info('PostgreSQL pool closed');
    }
};
exports.closePool = closePool;
//# sourceMappingURL=postgres.js.map