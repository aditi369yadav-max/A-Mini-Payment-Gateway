import { Pool, PoolClient } from 'pg';
import { config } from '../../config';
import { logger } from '../../utils/logger';

let pool: Pool | null = null;

export const getPool = (): Pool => {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false,
      min: config.db.pool.min,
      max: config.db.pool.max,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    pool.on('connect', () => logger.debug('PostgreSQL: new connection acquired'));
    pool.on('error', (err) => logger.error('PostgreSQL pool error', { error: err.message }));
  }
  return pool;
};

export const withTransaction = async <T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> => {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('DB transaction rolled back', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    client.release();
  }
};

export const query = async <T = unknown>(
  sql: string,
  params?: unknown[]
): Promise<T[]> => {
  const result = await getPool().query(sql, params);
  return result.rows as T[];
};

export const queryOne = async <T = unknown>(
  sql: string,
  params?: unknown[]
): Promise<T | null> => {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
};

export const closePool = async (): Promise<void> => {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info('PostgreSQL pool closed');
  }
};