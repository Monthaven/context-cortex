/**
 * server.js
 * Context Cortex — main entry point.
 *
 * Starts the Express HTTP API, initializes the DB pool, registers cron jobs
 * for periodic scans and health checks, and sets up chokidar file watchers
 * for incremental updates on each configured repo.
 *
 * Usage: node server.js
 */

import 'dotenv/config';
import express from 'express';
import cron from 'node-cron';
import chokidar from 'chokidar';
import { getConfig } from './src/config.js';
import { runSchema, closePool } from './src/db/connection.js';
import apiRouter from './src/api/routes.js';
import { runScan, scanFile } from './src/scan/index.js';
import { buildGraph } from './src/graph/builder.js';
import { runHealthCheck } from './src/check/snapshot.js';

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

let cfg;
try {
  cfg = getConfig();
} catch (err) {
  console.error(`[cortex] Configuration error: ${err.message}`);
  console.error(`[cortex] Copy cortex.config.example.json to cortex.config.json and configure it.`);
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '10mb' }));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (req.path !== '/status') { // Skip noisy health checks
      console.log(`[cortex:http] ${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    }
  });
  next();
});

// API routes
app.use('/', apiRouter);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

// ---------------------------------------------------------------------------
// Chokidar watchers (incremental scan)
// ---------------------------------------------------------------------------

const watchers = [];

function setupWatcher(repoConfig) {
  if (repoConfig.scan?.enabled === false) return;

  const { name, path: repoPath, scan: scanConfig } = repoConfig;
  const ignored = [
    ...(scanConfig.ignorePatterns || []),
    '**/.git/**',
    '**/node_modules/**',
  ];

  const watcher = chokidar.watch(repoPath, {
    ignored,
    persistent: true,
    ignoreInitial: true,
    usePolling: false,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    depth: 20,
  });

  let debounceMap = new Map();

  const handleChange = (filePath) => {
    // Debounce per-file: wait 1s after last change before scanning
    if (debounceMap.has(filePath)) {
      clearTimeout(debounceMap.get(filePath));
    }
    const timer = setTimeout(async () => {
      debounceMap.delete(filePath);
      try {
        await scanFile(repoConfig, filePath);
      } catch (err) {
        console.error(`[cortex:watch] Error scanning ${filePath}: ${err.message}`);
      }
    }, 1000);
    debounceMap.set(filePath, timer);
  };

  watcher
    .on('add', handleChange)
    .on('change', handleChange)
    .on('unlink', (filePath) => {
      // File deleted — scanFile handles cleanup
      handleChange(filePath);
    })
    .on('error', (err) => {
      console.error(`[cortex:watch] Watcher error for ${name}: ${err.message}`);
    });

  watchers.push(watcher);
  console.log(`[cortex:watch] Watching ${name} at: ${repoPath}`);
}

// ---------------------------------------------------------------------------
// Cron jobs
// ---------------------------------------------------------------------------

const cronJobs = [];

function setupCrons() {
  // Per-repo scan schedules
  for (const repoConfig of cfg.repos) {
    const schedule = repoConfig.scan?.schedule;
    if (!schedule || repoConfig.scan?.enabled === false) continue;

    if (!cron.validate(schedule)) {
      console.warn(`[cortex:cron] Invalid cron schedule for ${repoConfig.name}: "${schedule}"`);
      continue;
    }

    const job = cron.schedule(schedule, async () => {
      console.log(`[cortex:cron] Scheduled scan: ${repoConfig.name}`);
      try {
        await runScan(repoConfig);
        await buildGraph(repoConfig);
      } catch (err) {
        console.error(`[cortex:cron] Scan error for ${repoConfig.name}: ${err.message}`);
      }
    }, { scheduled: true });

    cronJobs.push(job);
    console.log(`[cortex:cron] Scan scheduled for ${repoConfig.name}: ${schedule}`);
  }

  // Global health check schedule
  const healthSchedule = cfg.health?.schedule || '*/15 * * * *';
  if (cron.validate(healthSchedule)) {
    const healthJob = cron.schedule(healthSchedule, async () => {
      for (const repoConfig of cfg.repos) {
        if (Object.keys(repoConfig.services || {}).length === 0) continue;
        try {
          await runHealthCheck(repoConfig);
        } catch (err) {
          console.error(`[cortex:cron] Health check error for ${repoConfig.name}: ${err.message}`);
        }
      }
    }, { scheduled: true });

    cronJobs.push(healthJob);
    console.log(`[cortex:cron] Health checks scheduled: ${healthSchedule}`);
  }
}

// ---------------------------------------------------------------------------
// Main startup
// ---------------------------------------------------------------------------

async function start() {
  console.log('[cortex] Starting Context Cortex...');
  console.log(`[cortex] Config: ${cfg._source === 'file' ? cfg._path : 'environment variables'}`);
  console.log(`[cortex] Repos: ${cfg.repos.map(r => r.name).join(', ') || '(none)'}`);

  // 1. Initialize database schema
  try {
    await runSchema();
  } catch (err) {
    console.error(`[cortex] Database initialization failed: ${err.message}`);
    console.error(`[cortex] Check database.host/port/user/password in cortex.config.json`);
    process.exit(1);
  }

  // 2. Start HTTP server
  const { port, host } = cfg.server;
  await new Promise((resolve) => {
    app.listen(port, host, () => {
      console.log(`[cortex] API server listening on http://${host}:${port}`);
      resolve();
    });
  });

  // 3. Set up cron jobs
  setupCrons();

  // 4. Set up file watchers
  for (const repoConfig of cfg.repos) {
    setupWatcher(repoConfig);
  }

  console.log('[cortex] Ready.');
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal) {
  console.log(`\n[cortex] ${signal} received — shutting down...`);

  // Stop cron jobs
  for (const job of cronJobs) {
    job.stop();
  }

  // Close watchers
  for (const watcher of watchers) {
    await watcher.close();
  }

  // Close DB pool
  await closePool();

  console.log('[cortex] Shutdown complete.');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  console.error('[cortex] Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[cortex] Unhandled rejection:', reason);
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

start().catch((err) => {
  console.error('[cortex] Fatal startup error:', err);
  process.exit(1);
});
