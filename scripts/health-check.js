/**
 * scripts/health-check.js
 * Runs health checks on all configured services across all repos.
 *
 * Usage:
 *   node scripts/health-check.js           — check all repos
 *   node scripts/health-check.js my-api    — check a specific repo
 *   node scripts/health-check.js --json    — output JSON
 */

import 'dotenv/config';
import { getConfig } from '../src/config.js';
import { runSchema, closePool } from '../src/db/connection.js';
import { runHealthCheck } from '../src/check/snapshot.js';

const args = process.argv.slice(2);
const targetRepo = args.find(a => !a.startsWith('--'));
const jsonOutput = args.includes('--json');

function statusIcon(status) {
  return { ok: '✓', degraded: '⚠', down: '✗', unknown: '?' }[status] || '?';
}

async function main() {
  let cfg;
  try {
    cfg = getConfig();
  } catch (err) {
    console.error(`Configuration error: ${err.message}`);
    process.exit(1);
  }

  // Initialize schema (needed for storing snapshots)
  await runSchema();

  let repos = cfg.repos;
  if (targetRepo) {
    repos = repos.filter(r => r.name === targetRepo);
    if (repos.length === 0) {
      console.error(`Repo not found: "${targetRepo}"`);
      console.error(`Available repos: ${cfg.repos.map(r => r.name).join(', ')}`);
      await closePool();
      process.exit(1);
    }
  }

  const allResults = {};
  let anyDown = false;

  for (const repoConfig of repos) {
    const { name, services = {} } = repoConfig;
    const serviceCount = Object.keys(services).length;

    if (serviceCount === 0) {
      if (!jsonOutput) console.log(`[${name}] No services configured — skipping`);
      allResults[name] = [];
      continue;
    }

    if (!jsonOutput) {
      console.log(`\n[${name}] Checking ${serviceCount} service(s)...`);
    }

    try {
      const results = await runHealthCheck(repoConfig);
      allResults[name] = results;

      if (!jsonOutput) {
        for (const r of results) {
          const icon = statusIcon(r.status);
          const latency = r.latencyMs != null ? `${r.latencyMs}ms` : '';
          const err = r.errorMessage ? ` — ${r.errorMessage}` : '';
          console.log(`  ${icon} ${r.serviceName} (${r.status}) ${latency}${err}`);
        }
      }

      if (results.some(r => r.status !== 'ok')) {
        anyDown = true;
      }
    } catch (err) {
      allResults[name] = [{ error: err.message }];
      anyDown = true;
      if (!jsonOutput) {
        console.error(`  ✗ Health check error: ${err.message}`);
      }
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify(allResults, null, 2));
  } else {
    const totalServices = Object.values(allResults).flat().length;
    const okServices = Object.values(allResults).flat().filter(r => r.status === 'ok').length;
    console.log('');
    console.log(`Overall: ${okServices}/${totalServices} services healthy`);
  }

  await closePool();
  process.exit(anyDown ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal health check error:', err);
  process.exit(1);
});
