/**
 * scripts/full-scan.js
 * Manual full scan of all configured repos (or a specific one).
 *
 * Usage:
 *   node scripts/full-scan.js              — scan all repos
 *   node scripts/full-scan.js my-api       — scan a specific repo
 *   node scripts/full-scan.js my-api --no-graph  — skip graph build
 *   node scripts/full-scan.js my-api --no-dump   — skip CLAUDE.md generation
 */

import 'dotenv/config';
import { getConfig } from '../src/config.js';
import { runSchema, closePool } from '../src/db/connection.js';
import { runScan } from '../src/scan/index.js';
import { buildGraph } from '../src/graph/builder.js';
import { writeClaudeMd } from '../src/dump/claude-md.js';

const args = process.argv.slice(2);
const targetRepo = args.find(a => !a.startsWith('--'));
const skipGraph = args.includes('--no-graph');
const skipDump = args.includes('--no-dump');

async function main() {
  console.log('[cortex:scan] Full scan starting...');

  let cfg;
  try {
    cfg = getConfig();
  } catch (err) {
    console.error(`Configuration error: ${err.message}`);
    process.exit(1);
  }

  // Initialize schema (idempotent)
  await runSchema();

  // Select repos to scan
  let repos = cfg.repos;
  if (targetRepo) {
    repos = cfg.repos.filter(r => r.name === targetRepo);
    if (repos.length === 0) {
      console.error(`Repo not found: "${targetRepo}"`);
      console.error(`Available repos: ${cfg.repos.map(r => r.name).join(', ')}`);
      await closePool();
      process.exit(1);
    }
  }

  console.log(`[cortex:scan] Scanning ${repos.length} repo(s): ${repos.map(r => r.name).join(', ')}`);
  const overallStart = Date.now();

  const results = [];

  for (const repoConfig of repos) {
    const { name } = repoConfig;
    const repoStart = Date.now();
    const result = { name, errors: [] };

    // Scan
    try {
      result.scan = await runScan(repoConfig);
    } catch (err) {
      result.errors.push(err.message);
      console.error(`[cortex:scan] ${name}: scan failed: ${err.message}`);
    }

    // Graph
    if (!skipGraph) {
      try {
        result.graph = await buildGraph(repoConfig);
      } catch (err) {
        result.errors.push(`graph: ${err.message}`);
        console.error(`[cortex:scan] ${name}: graph build failed: ${err.message}`);
      }
    }

    // CLAUDE.md
    if (!skipDump) {
      try {
        result.dump = await writeClaudeMd(repoConfig);
      } catch (err) {
        result.errors.push(`dump: ${err.message}`);
        console.error(`[cortex:scan] ${name}: CLAUDE.md generation failed: ${err.message}`);
      }
    }

    result.durationMs = Date.now() - repoStart;
    results.push(result);
  }

  // Summary
  const totalMs = Date.now() - overallStart;
  console.log('');
  console.log(`[cortex:scan] ── Summary (${totalMs}ms total) ──`);

  let exitCode = 0;
  for (const r of results) {
    const ok = r.errors.length === 0;
    if (!ok) exitCode = 1;
    console.log(
      `  ${ok ? '✓' : '✗'} ${r.name} (${r.durationMs}ms)` +
      (r.scan ? ` — ${r.scan.files} files, ${r.scan.upserted} chunks` : '') +
      (r.graph ? `, ${r.graph.edges} edges` : '') +
      (r.dump ? `, CLAUDE.md written` : '')
    );
    if (r.errors.length > 0) {
      for (const e of r.errors) console.error(`      ERROR: ${e}`);
    }
  }

  await closePool();
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('[cortex:scan] Fatal error:', err);
  process.exit(1);
});
