/**
 * src/db/connection.js
 * PostgreSQL pool for the cortex schema.
 * Exports getPool(), runSchema(), and externalPool() for inspecting other databases.
 */

import pg from 'pg';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getConfig } from '../config.js';

const { Pool } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));

let _pool = null;

// ---------------------------------------------------------------------------
// Primary pool (cortex schema)
// ---------------------------------------------------------------------------

export function getPool() {
  if (_pool) return _pool;

  const cfg = getConfig();
  const dbCfg = cfg.database;

  _pool = new Pool({
    host: dbCfg.host,
    port: dbCfg.port,
    database: dbCfg.database,
    user: dbCfg.user,
    password: dbCfg.password,
    ssl: dbCfg.ssl ? { rejectUnauthorized: false } : false,
    max: dbCfg.max || 10,
    idleTimeoutMillis: dbCfg.idleTimeoutMillis || 30000,
    connectionTimeoutMillis: dbCfg.connectionTimeoutMillis || 5000,
  });

  _pool.on('error', (err) => {
    console.error('[cortex:db] Unexpected pool error:', err.message);
  });

  _pool.on('connect', () => {
    // Set search_path on each new connection
    // No-op here — queries always use cortex. prefix
  });

  return _pool;
}

// ---------------------------------------------------------------------------
// Schema initializer
// ---------------------------------------------------------------------------

export async function runSchema() {
  const pool = getPool();
  const schemaPath = resolve(__dirname, 'schema.sql');

  let sql;
  try {
    sql = readFileSync(schemaPath, 'utf8');
  } catch (err) {
    throw new Error(`[cortex:db] Cannot read schema.sql: ${err.message}`);
  }

  const client = await pool.connect();
  try {
    console.log('[cortex:db] Running schema.sql...');
    await client.query(sql);
    console.log('[cortex:db] Schema applied successfully.');
  } catch (err) {
    // pgvector may not be installed — warn but don't crash
    if (err.message.includes('extension') && err.message.includes('vector')) {
      console.warn('[cortex:db] pgvector extension not available. Embeddings will be disabled.');
      // Run schema without the vector extension lines
      const fallback = sql
        .replace(/CREATE EXTENSION IF NOT EXISTS vector;/g, '-- vector extension skipped')
        .replace(/embedding\s+vector\(\d+\)/g, 'embedding TEXT')
        .replace(/CREATE INDEX[^;]*ivfflat[^;]*;/g, '-- ivfflat index skipped (no pgvector)');
      await client.query(fallback);
      console.log('[cortex:db] Schema applied (no vector support).');
    } else {
      throw err;
    }
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

export async function query(sql, params = []) {
  const pool = getPool();
  const res = await pool.query(sql, params);
  return res;
}

export async function queryOne(sql, params = []) {
  const res = await query(sql, params);
  return res.rows[0] || null;
}

export async function queryRows(sql, params = []) {
  const res = await query(sql, params);
  return res.rows;
}

export async function withClient(fn) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function withTransaction(fn) {
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

// ---------------------------------------------------------------------------
// External pool factory
// Used when Context Cortex needs to inspect an external database
// (e.g. to list tables owned by a repo, or verify service connectivity).
// ---------------------------------------------------------------------------

export function externalPool(config) {
  const pool = new Pool({
    host: config.host,
    port: config.port || 5432,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: config.ssl ? { rejectUnauthorized: false } : false,
    max: config.max || 5,
    idleTimeoutMillis: config.idleTimeoutMillis || 15000,
    connectionTimeoutMillis: config.connectionTimeoutMillis || 5000,
  });

  pool.on('error', (err) => {
    console.error(`[cortex:db:external] Pool error (${config.host}:${config.port}):`, err.message);
  });

  return pool;
}

// ---------------------------------------------------------------------------
// Log an error to cortex.errors table (non-throwing)
// ---------------------------------------------------------------------------

export async function logError({ repoName, operation, filePath, errorCode, message, stack, meta = {} }) {
  try {
    await query(
      `INSERT INTO cortex.errors (repo_name, operation, file_path, error_code, message, stack, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [repoName || null, operation, filePath || null, errorCode || null, message, stack || null, meta]
    );
  } catch {
    // Don't let error logging crash anything
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

export async function closePool() {
  if (_pool) {
    await _pool.end();
    _pool = null;
    console.log('[cortex:db] Pool closed.');
  }
}
