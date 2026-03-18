/**
 * scripts/reset.js
 * Drops and recreates the cortex schema.
 *
 * WARNING: This deletes ALL data — code_chunks, graph_edges, health_snapshots,
 * scan_log, errors, and table_ownership. Use with care.
 *
 * Usage:
 *   node scripts/reset.js           — prompts for confirmation
 *   node scripts/reset.js --force   — skips confirmation (for CI/scripts)
 */

import 'dotenv/config';
import { createInterface } from 'readline';
import { getConfig } from '../src/config.js';
import { getPool, runSchema, closePool } from '../src/db/connection.js';

const args = process.argv.slice(2);
const force = args.includes('--force') || args.includes('-f');

async function confirm(question) {
  if (force) return true;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes');
    });
  });
}

async function reset() {
  let cfg;
  try {
    cfg = getConfig();
  } catch (err) {
    console.error(`Configuration error: ${err.message}`);
    process.exit(1);
  }

  console.log('Context Cortex — Schema Reset');
  console.log('');
  console.log('This will DROP the cortex schema and ALL its data:');
  console.log('  - cortex.code_chunks');
  console.log('  - cortex.graph_edges');
  console.log('  - cortex.health_snapshots');
  console.log('  - cortex.scan_log');
  console.log('  - cortex.errors');
  console.log('  - cortex.table_ownership');
  console.log('');
  console.log(`Database: ${cfg.database.host}:${cfg.database.port}/${cfg.database.database}`);
  console.log('');

  const ok = await confirm('Are you sure? (y/N) ');
  if (!ok) {
    console.log('Reset cancelled.');
    await closePool();
    process.exit(0);
  }

  const pool = getPool();
  const client = await pool.connect();

  try {
    console.log('Dropping cortex schema...');
    await client.query('DROP SCHEMA IF EXISTS cortex CASCADE');
    console.log('  ✓ cortex schema dropped');

    console.log('Recreating schema...');
    await client.release();
    await runSchema();
    console.log('  ✓ Schema recreated');

    console.log('');
    console.log('Reset complete. Run `npm run setup` or `npm run scan` to repopulate.');
  } catch (err) {
    client.release();
    console.error(`Reset failed: ${err.message}`);
    await closePool();
    process.exit(1);
  }

  await closePool();
  process.exit(0);
}

reset().catch((err) => {
  console.error('Fatal error during reset:', err);
  process.exit(1);
});
