/**
 * scripts/setup.js
 * First-time initialization:
 *   1. Runs schema.sql to create cortex schema and tables
 *   2. Scans all configured repos
 *   3. Builds knowledge graphs for all repos
 *   4. Runs initial health checks
 *   5. Generates CLAUDE.md for each repo
 */

import 'dotenv/config';
import { getConfig } from '../src/config.js';
import { runSchema, closePool } from '../src/db/connection.js';
import { runScan } from '../src/scan/index.js';
import { buildGraph } from '../src/graph/builder.js';
import { runHealthCheck } from '../src/check/snapshot.js';
import { writeClaudeMd } from '../src/dump/claude-md.js';

async function setup() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║       Context Cortex — First-time Setup  ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  let cfg;
  try {
    cfg = getConfig();
  } catch (err) {
    console.error(`Configuration error: ${err.message}`);
    console.error('');
    console.error('  1. Copy cortex.config.example.json to cortex.config.json');
    console.error('  2. Edit cortex.config.json with your database credentials and repo paths');
    console.error('  3. Run: npm run setup');
    process.exit(1);
  }

  console.log(`Config loaded from: ${cfg._path || 'environment variables'}`);
  console.log(`Repos to scan: ${cfg.repos.length}`);
  console.log('');

  // ---------------------------------------------------------------------------
  // Step 1: Schema
  // ---------------------------------------------------------------------------
  console.log('Step 1/5: Initializing database schema...');
  try {
    await runSchema();
    console.log('  ✓ Schema applied\n');
  } catch (err) {
    console.error(`  ✗ Schema failed: ${err.message}`);
    console.error('  Check your database connection settings in cortex.config.json');
    await closePool();
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // Steps 2-5: Per-repo
  // ---------------------------------------------------------------------------
  const results = [];

  for (const repoConfig of cfg.repos) {
    const { name } = repoConfig;
    console.log(`━━━ Repo: ${name} ━━━`);

    const repoResult = { name, scan: null, graph: null, health: null, dump: null, errors: [] };

    // Step 2: Scan
    console.log(`  Step 2/5: Scanning ${name}...`);
    try {
      repoResult.scan = await runScan(repoConfig);
      console.log(`  ✓ Scan: ${repoResult.scan.files} files, ${repoResult.scan.upserted} chunks`);
    } catch (err) {
      repoResult.errors.push(`scan: ${err.message}`);
      console.error(`  ✗ Scan failed: ${err.message}`);
    }

    // Step 3: Graph
    console.log(`  Step 3/5: Building knowledge graph for ${name}...`);
    try {
      repoResult.graph = await buildGraph(repoConfig);
      console.log(`  ✓ Graph: ${repoResult.graph.edges} edges`);
    } catch (err) {
      repoResult.errors.push(`graph: ${err.message}`);
      console.error(`  ✗ Graph failed: ${err.message}`);
    }

    // Step 4: Health checks
    const serviceCount = Object.keys(repoConfig.services || {}).length;
    if (serviceCount > 0) {
      console.log(`  Step 4/5: Health checking ${serviceCount} services for ${name}...`);
      try {
        const health = await runHealthCheck(repoConfig);
        repoResult.health = health;
        const ok = health.filter(h => h.status === 'ok').length;
        console.log(`  ✓ Health: ${ok}/${health.length} services ok`);
      } catch (err) {
        repoResult.errors.push(`health: ${err.message}`);
        console.error(`  ✗ Health check failed: ${err.message}`);
      }
    } else {
      console.log(`  Step 4/5: No services configured for ${name} — skipping health checks`);
    }

    // Step 5: Generate CLAUDE.md
    console.log(`  Step 5/5: Generating CLAUDE.md for ${name}...`);
    try {
      const outputPath = await writeClaudeMd(repoConfig);
      repoResult.dump = outputPath;
      console.log(`  ✓ CLAUDE.md: ${outputPath}`);
    } catch (err) {
      repoResult.errors.push(`dump: ${err.message}`);
      console.error(`  ✗ CLAUDE.md generation failed: ${err.message}`);
    }

    results.push(repoResult);
    console.log('');
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log('╔══════════════════════════════════════════╗');
  console.log('║              Setup Summary               ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  let allOk = true;
  for (const r of results) {
    const status = r.errors.length === 0 ? '✓' : '✗';
    console.log(`  ${status} ${r.name}`);
    if (r.scan) console.log(`      Files: ${r.scan.files}, Chunks: ${r.scan.upserted}`);
    if (r.graph) console.log(`      Edges: ${r.graph.edges}`);
    if (r.dump) console.log(`      CLAUDE.md: ${r.dump}`);
    if (r.errors.length > 0) {
      allOk = false;
      for (const err of r.errors) console.error(`      ERROR: ${err}`);
    }
  }

  console.log('');
  if (allOk) {
    console.log('=== Setup Complete ===');
    console.log('Next steps:');
    console.log('1. Start the server: npm start');
    console.log('2. Add MCP to Claude Code: npm run add-to-claude');
    console.log('3. Restart Claude Code to connect');
    console.log('4. Verify: ask Claude to run cortex_system_status');
  } else {
    console.log('Setup completed with errors. Review the output above.');
    console.log('');
    console.log('Once errors are resolved:');
    console.log('1. Start the server: npm start');
    console.log('2. Add MCP to Claude Code: npm run add-to-claude');
    console.log('3. Restart Claude Code to connect');
    console.log('4. Verify: ask Claude to run cortex_system_status');
  }

  await closePool();
  process.exit(allOk ? 0 : 1);
}

setup().catch((err) => {
  console.error('Fatal setup error:', err);
  process.exit(1);
});
