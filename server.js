/**
 * server.js
 * Context Cortex — main entry point.
 *
 * Starts the Express HTTP API, initializes the DB pool, registers cron jobs
 * for periodic scans and health checks, sets up chokidar file watchers
 * for incremental updates, and runs background automation:
 *   - Git commit watcher (60s poll) — logs to work_log + triggers incremental scan
 *   - CLAUDE.md auto-dump (every 4 hours + on startup with 30s delay)
 *
 * Usage: node server.js
 */

import 'dotenv/config';
import express from 'express';
import cron from 'node-cron';
import chokidar from 'chokidar';
import { execFileSync } from 'child_process';
import { getConfig } from './src/config.js';
import { runSchema, closePool } from './src/db/connection.js';
import apiRouter from './src/api/routes.js';
import workLogRouter, { logWork } from './src/api/work-log-routes.js';
import extendedRoutes from './src/api/extended-routes.js';
import { runScan, scanFile } from './src/scan/index.js';
import { buildGraph } from './src/graph/builder.js';
import { runHealthCheck } from './src/check/snapshot.js';
import { dumpClaudeMd } from './src/dump/claude-md.js';

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
app.use('/', workLogRouter);
app.use('/', extendedRoutes);

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
// Git Commit Watcher (poll every 60s for each repo)
// ---------------------------------------------------------------------------

const _lastCommit = {};

function inferCategory(msg = '') {
  const m = msg.toLowerCase();
  if (m.startsWith('fix') || m.startsWith('bug') || m.includes('hotfix')) return 'fix';
  if (m.startsWith('feat') || m.startsWith('add ') || m.startsWith('new ')) return 'feature';
  if (m.startsWith('refactor') || m.startsWith('rework')) return 'refactor';
  if (m.startsWith('test') || m.startsWith('spec')) return 'test';
  if (m.startsWith('chore') || m.startsWith('config')) return 'config';
  if (m.startsWith('deploy') || m.startsWith('release')) return 'deploy';
  if (m.startsWith('debug')) return 'debug';
  if (m.startsWith('build') || m.startsWith('ci')) return 'build';
  return 'build';
}

function setupGitWatcher() {
  setInterval(async () => {
    for (const repo of cfg.repos) {
      try {
        const head = execFileSync('git', ['-C', repo.path, 'rev-parse', 'HEAD'],
          { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();

        if (_lastCommit[repo.name] && _lastCommit[repo.name] !== head) {
          // New commit detected
          const subject = execFileSync('git', ['-C', repo.path, 'log', '-1', '--pretty=format:%s'],
            { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();
          const filesOut = execFileSync('git', ['-C', repo.path, 'diff-tree', '--no-commit-id', '-r', '--name-only', head],
            { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();
          const files = filesOut.split('\n').filter(Boolean).slice(0, 30);

          const cat = inferCategory(subject);

          logWork({
            repo: repo.name,
            category: cat,
            summary: subject.slice(0, 300),
            files_touched: files,
            status: 'completed',
            commit_hash: head.slice(0, 7),
            tags: ['git-auto'],
          });
          console.log(`[cortex:git] ${repo.name}: new commit ${head.slice(0, 7)} — ${subject.slice(0, 80)}`);

          // Auto-scan changed files — re-chunk + re-embed
          if (files.length > 0) {
            const fullPaths = files.map(f => repo.path.replace(/\\/g, '/') + '/' + f);
            for (const fp of fullPaths) {
              try {
                await scanFile(repo, fp);
              } catch {
                // Non-critical — file may not match scan extensions
              }
            }
            console.log(`[cortex:git] Re-scanned ${files.length} changed files in ${repo.name}`);
          }
        }
        _lastCommit[repo.name] = head;
      } catch {
        // Repo may not be a git repo or path may not exist — skip silently
      }
    }
  }, 60 * 1000);

  console.log('[cortex:git] Git commit watcher started (60s poll)');
}

// ---------------------------------------------------------------------------
// CLAUDE.md Auto-Dump (every 4 hours + on startup)
// ---------------------------------------------------------------------------

function setupClaudeMdAutoDump() {
  const CLAUDE_DUMP_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours

  // Periodic refresh
  setInterval(async () => {
    try {
      const result = await dumpClaudeMd();
      console.log(`[cortex:dump] Auto-refreshed ${result.written.length} CLAUDE.md files`);
    } catch (err) {
      console.error(`[cortex:dump] Auto-refresh failed: ${err.message}`);
    }
  }, CLAUDE_DUMP_INTERVAL);

  // Startup dump (30s delay for DB warmup)
  setTimeout(async () => {
    try {
      const result = await dumpClaudeMd();
      console.log(`[cortex:dump] Startup refresh: ${result.written.length} CLAUDE.md files`);
    } catch (err) {
      console.error(`[cortex:dump] Startup refresh failed: ${err.message}`);
    }
  }, 30 * 1000);

  console.log('[cortex:dump] CLAUDE.md auto-dump scheduled (every 4h + startup)');
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

  // 5. Set up git commit watcher
  setupGitWatcher();

  // 6. Set up CLAUDE.md auto-dump
  setupClaudeMdAutoDump();

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
