/**
 * src/api/routes.js
 * Express router for the Context Cortex HTTP API.
 *
 * All routes are prefixed with nothing (mounted at / in server.js).
 * Authentication is via X-API-Key header or ?api_key= query param.
 */

import { Router } from 'express';
import { getConfig, getRepoConfig } from '../config.js';
import { queryRows, queryOne, query } from '../db/connection.js';
import { runScan } from '../scan/index.js';
import { buildGraph } from '../graph/builder.js';
import { runHealthCheck, getLatestHealth } from '../check/snapshot.js';
import { writeClaudeMd } from '../dump/claude-md.js';

const router = Router();

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

function requireAuth(req, res, next) {
  const cfg = getConfig();
  const apiKey = cfg.server?.apiKey;

  // No API key configured — open access
  if (!apiKey) return next();

  const provided = req.headers['x-api-key'] || req.query.api_key;
  if (!provided || provided !== apiKey) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Valid X-API-Key required' });
  }

  next();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function repoNotFound(res, name) {
  return res.status(404).json({ error: 'Not found', message: `Repo not found: ${name}` });
}

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// ---------------------------------------------------------------------------
// GET /status
// System status overview
// ---------------------------------------------------------------------------

router.get('/status', asyncHandler(async (req, res) => {
  const cfg = getConfig();

  // DB check
  let dbOk = false;
  let dbError = null;
  try {
    await query('SELECT 1');
    dbOk = true;
  } catch (err) {
    dbError = err.message;
  }

  // Scan stats
  const scanStats = await queryOne(
    `SELECT COUNT(*) AS total_chunks,
            COUNT(DISTINCT repo_name) AS repos_with_data,
            MAX(updated_at) AS last_updated
     FROM cortex.code_chunks`
  ).catch(() => null);

  const recentErrors = await queryOne(
    `SELECT COUNT(*) AS error_count
     FROM cortex.errors
     WHERE created_at > NOW() - INTERVAL '1 hour'`
  ).catch(() => null);

  res.json({
    status: dbOk ? 'ok' : 'degraded',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
    database: { connected: dbOk, error: dbError },
    repos: cfg.repos.length,
    chunks: Number(scanStats?.total_chunks || 0),
    reposWithData: Number(scanStats?.repos_with_data || 0),
    recentErrors: Number(recentErrors?.error_count || 0),
    lastUpdated: scanStats?.last_updated || null,
  });
}));

// ---------------------------------------------------------------------------
// GET /repos
// List all configured repos
// ---------------------------------------------------------------------------

router.get('/repos', requireAuth, asyncHandler(async (req, res) => {
  const cfg = getConfig();

  const repoStats = await queryRows(
    `SELECT repo_name,
            COUNT(*) AS chunk_count,
            COUNT(DISTINCT relative_path) AS file_count,
            MAX(updated_at) AS last_scanned
     FROM cortex.code_chunks
     GROUP BY repo_name`
  ).catch(() => []);

  const statsMap = Object.fromEntries(repoStats.map(r => [r.repo_name, r]));

  const repos = cfg.repos.map(repo => ({
    name: repo.name,
    description: repo.description || null,
    path: repo.path,
    language: repo.language || null,
    scan: {
      enabled: repo.scan?.enabled !== false,
      schedule: repo.scan?.schedule || null,
    },
    services: Object.keys(repo.services || {}),
    stats: statsMap[repo.name] ? {
      chunks: Number(statsMap[repo.name].chunk_count),
      files: Number(statsMap[repo.name].file_count),
      lastScanned: statsMap[repo.name].last_scanned,
    } : null,
  }));

  res.json({ repos });
}));

// ---------------------------------------------------------------------------
// GET /repos/:name/chunks
// Code chunks for a repo (with optional filters)
// ---------------------------------------------------------------------------

router.get('/repos/:name/chunks', requireAuth, asyncHandler(async (req, res) => {
  const cfg = getConfig();
  const repoName = req.params.name;

  if (!cfg.repos.find(r => r.name === repoName)) {
    return repoNotFound(res, repoName);
  }

  const {
    file,
    type,
    language,
    limit = '50',
    offset = '0',
  } = req.query;

  const params = [repoName];
  const conditions = ['repo_name = $1'];

  if (file) {
    params.push(`%${file}%`);
    conditions.push(`relative_path ILIKE $${params.length}`);
  }
  if (type) {
    params.push(type);
    conditions.push(`chunk_type = $${params.length}`);
  }
  if (language) {
    params.push(language);
    conditions.push(`language = $${params.length}`);
  }

  const where = conditions.join(' AND ');
  const lim = Math.min(parseInt(limit, 10) || 50, 500);
  const off = parseInt(offset, 10) || 0;

  params.push(lim, off);

  const chunks = await queryRows(
    `SELECT id, relative_path, chunk_name, chunk_type, language,
            start_line, end_line, token_estimate,
            content_hash, file_mtime, updated_at
     FROM cortex.code_chunks
     WHERE ${where}
     ORDER BY relative_path, start_line
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const total = await queryOne(
    `SELECT COUNT(*) AS n FROM cortex.code_chunks WHERE ${where}`,
    params.slice(0, -2)
  );

  res.json({
    repo: repoName,
    total: Number(total?.n || 0),
    limit: lim,
    offset: off,
    chunks,
  });
}));

// ---------------------------------------------------------------------------
// GET /repos/:name/graph
// Knowledge graph edges for a repo
// ---------------------------------------------------------------------------

router.get('/repos/:name/graph', requireAuth, asyncHandler(async (req, res) => {
  const cfg = getConfig();
  const repoName = req.params.name;

  if (!cfg.repos.find(r => r.name === repoName)) {
    return repoNotFound(res, repoName);
  }

  const { type, limit = '200' } = req.query;
  const { getGraphEdges } = await import('../graph/builder.js');

  const edges = await getGraphEdges(repoName, {
    edgeType: type || null,
    limit: Math.min(parseInt(limit, 10) || 200, 2000),
  });

  // Summary stats
  const stats = await queryOne(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN edge_type = 'import' THEN 1 ELSE 0 END) AS imports,
       SUM(CASE WHEN edge_type = 'route' THEN 1 ELSE 0 END) AS routes,
       SUM(CASE WHEN edge_type = 'db_query' THEN 1 ELSE 0 END) AS db_queries
     FROM cortex.graph_edges
     WHERE repo_name = $1`,
    [repoName]
  );

  res.json({
    repo: repoName,
    stats: {
      total: Number(stats?.total || 0),
      imports: Number(stats?.imports || 0),
      routes: Number(stats?.routes || 0),
      dbQueries: Number(stats?.db_queries || 0),
    },
    edges,
  });
}));

// ---------------------------------------------------------------------------
// GET /repos/:name/health
// Health snapshots for a repo
// ---------------------------------------------------------------------------

router.get('/repos/:name/health', requireAuth, asyncHandler(async (req, res) => {
  const cfg = getConfig();
  const repoName = req.params.name;

  if (!cfg.repos.find(r => r.name === repoName)) {
    return repoNotFound(res, repoName);
  }

  const latest = await getLatestHealth(repoName);

  const allOk = latest.length > 0 && latest.every(h => h.status === 'ok');

  res.json({
    repo: repoName,
    overall: latest.length === 0 ? 'unknown' : allOk ? 'ok' : 'degraded',
    services: latest,
  });
}));

// ---------------------------------------------------------------------------
// GET /search?q=term&repo=name
// Full-text search across code chunks
// ---------------------------------------------------------------------------

router.get('/search', requireAuth, asyncHandler(async (req, res) => {
  const { q, repo, type, limit = '20' } = req.query;

  if (!q || q.trim().length < 2) {
    return res.status(400).json({ error: 'Bad request', message: 'q parameter is required (min 2 chars)' });
  }

  const lim = Math.min(parseInt(limit, 10) || 20, 100);
  const params = [q.trim()];
  const conditions = [];

  if (repo) {
    params.push(repo);
    conditions.push(`repo_name = $${params.length}`);
  }
  if (type) {
    params.push(type);
    conditions.push(`chunk_type = $${params.length}`);
  }

  const where = conditions.length ? `AND ${conditions.join(' AND ')}` : '';
  params.push(lim);

  // Full-text search on content + name
  const chunks = await queryRows(
    `SELECT id, repo_name, relative_path, chunk_name, chunk_type, language,
            start_line, end_line, token_estimate,
            ts_rank(to_tsvector('english', COALESCE(content, '') || ' ' || COALESCE(chunk_name, '')),
                    plainto_tsquery('english', $1)) AS rank,
            LEFT(content, 200) AS content_preview
     FROM cortex.code_chunks
     WHERE to_tsvector('english', COALESCE(content, '') || ' ' || COALESCE(chunk_name, ''))
           @@ plainto_tsquery('english', $1)
       ${where}
     ORDER BY rank DESC
     LIMIT $${params.length}`,
    params
  );

  res.json({
    query: q,
    total: chunks.length,
    results: chunks,
  });
}));

// ---------------------------------------------------------------------------
// POST /scan/:name
// Trigger a full scan for a repo
// ---------------------------------------------------------------------------

router.post('/scan/:name', requireAuth, asyncHandler(async (req, res) => {
  const cfg = getConfig();
  const repoName = req.params.name;
  const repoConfig = cfg.repos.find(r => r.name === repoName);

  if (!repoConfig) return repoNotFound(res, repoName);

  // Fire-and-forget — don't await
  const scanPromise = runScan(repoConfig)
    .then(stats => {
      console.log(`[cortex:api] Scan completed for ${repoName}:`, stats);
      // Also rebuild graph
      return buildGraph(repoConfig);
    })
    .catch(err => console.error(`[cortex:api] Scan error for ${repoName}: ${err.message}`));

  res.json({
    message: `Scan started for ${repoName}`,
    repo: repoName,
    timestamp: new Date().toISOString(),
  });
}));

// ---------------------------------------------------------------------------
// POST /health/:name
// Trigger health checks for a repo
// ---------------------------------------------------------------------------

router.post('/health/:name', requireAuth, asyncHandler(async (req, res) => {
  const cfg = getConfig();
  const repoName = req.params.name;
  const repoConfig = cfg.repos.find(r => r.name === repoName);

  if (!repoConfig) return repoNotFound(res, repoName);

  const results = await runHealthCheck(repoConfig);
  const allOk = results.length > 0 && results.every(r => r.status === 'ok');

  res.json({
    repo: repoName,
    overall: results.length === 0 ? 'unknown' : allOk ? 'ok' : 'degraded',
    services: results,
    timestamp: new Date().toISOString(),
  });
}));

// ---------------------------------------------------------------------------
// POST /dump/:name
// Generate and write CLAUDE.md for a repo
// ---------------------------------------------------------------------------

router.post('/dump/:name', requireAuth, asyncHandler(async (req, res) => {
  const cfg = getConfig();
  const repoName = req.params.name;
  const repoConfig = cfg.repos.find(r => r.name === repoName);

  if (!repoConfig) return repoNotFound(res, repoName);

  const outputPath = await writeClaudeMd(repoConfig);

  res.json({
    repo: repoName,
    outputPath,
    timestamp: new Date().toISOString(),
  });
}));

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------

router.use((err, req, res, next) => {
  console.error(`[cortex:api] Unhandled error: ${err.message}`);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'production' ? 'An error occurred' : err.message,
  });
});

export default router;
