/**
 * src/api/extended-routes.js — Extended Context Cortex API routes
 *
 * Adds: /ext/status, /ext/search, /ext/topology, /ext/context,
 *       /ext/errors (GET/POST), /ext/errors/:id/resolve
 *
 * Ported from sona-cortex, adapted for context-cortex's DB pattern
 * (getPool/query/queryRows/queryOne from connection.js).
 */

import { Router } from 'express';
import { getConfig } from '../config.js';
import { query, queryRows, queryOne, logError } from '../db/connection.js';

const router = Router();

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const cfg = getConfig();
  const apiKey = cfg.server?.apiKey;
  if (!apiKey) return next();

  const provided = req.headers['x-api-key'] || req.query.api_key;
  if (!provided || provided !== apiKey) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
}

// ── Async handler ─────────────────────────────────────────────────────────────
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// ── Ollama embed helper ───────────────────────────────────────────────────────
async function embedText(text) {
  const cfg = getConfig();
  const url = cfg.ollama?.host || process.env.OLLAMA_URL || 'http://localhost:11434';
  const model = cfg.ollama?.model || 'nomic-embed-text';
  const res = await fetch(`${url}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: text.slice(0, 4000) }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  const data = await res.json();
  return data.embedding;
}

// ── GET /ext/status ───────────────────────────────────────────────────────────
router.get('/ext/status', requireAuth, asyncHandler(async (req, res) => {
  const [codebase, health, embeddings, scan, errCount] = await Promise.allSettled([
    queryOne(
      `SELECT
        COUNT(DISTINCT relative_path) as files,
        COUNT(*) as chunks,
        COUNT(*) FILTER (WHERE chunk_type = 'route') as routes
       FROM cortex.code_chunks`
    ),
    queryOne(
      `SELECT
        COUNT(*) FILTER (WHERE status = 'ok') as up,
        COUNT(*) FILTER (WHERE status = 'down') as down,
        COUNT(*) FILTER (WHERE status = 'degraded') as degraded,
        COUNT(*) as total,
        MAX(checked_at) as last_checked
       FROM (
         SELECT DISTINCT ON (service_name) service_name, status, checked_at
         FROM cortex.health_snapshots ORDER BY service_name, checked_at DESC
       ) latest`
    ),
    queryOne(`SELECT COUNT(*) as total, COUNT(embedding) as embedded FROM cortex.code_chunks`),
    queryOne(`SELECT MAX(completed_at) as last_scan FROM cortex.scan_log WHERE status = 'completed'`),
    queryOne(`SELECT COUNT(*) as cnt FROM cortex.errors WHERE created_at > NOW() - INTERVAL '7 days'`),
  ]);

  const cb = codebase.status === 'fulfilled' ? codebase.value || {} : {};
  const h  = health.status === 'fulfilled' ? health.value || {} : {};
  const em = embeddings.status === 'fulfilled' ? embeddings.value || {} : {};
  const sc = scan.status === 'fulfilled' ? scan.value || {} : {};
  const er = errCount.status === 'fulfilled' ? errCount.value || {} : {};

  const totalChunks = parseInt(em.total || 0);
  const embeddedChunks = parseInt(em.embedded || 0);

  res.json({
    success: true,
    codebase: {
      files:  parseInt(cb.files  || 0),
      chunks: parseInt(cb.chunks || 0),
      routes: parseInt(cb.routes || 0),
    },
    services: {
      up:       parseInt(h.up       || 0),
      down:     parseInt(h.down     || 0),
      degraded: parseInt(h.degraded || 0),
      total:    parseInt(h.total    || 0),
    },
    embeddings: {
      total:    totalChunks,
      embedded: embeddedChunks,
      null:     totalChunks - embeddedChunks,
      pct:      totalChunks > 0 ? Math.round(embeddedChunks / totalChunks * 100) : 0,
    },
    errors: { recent: parseInt(er.cnt || 0) },
    lastScan:        sc.last_scan || null,
    lastHealthCheck: h.last_checked || null,
  });
}));

// ── GET /ext/search?q=&limit=10&repo= ────────────────────────────────────────
router.get('/ext/search', requireAuth, asyncHandler(async (req, res) => {
  const { q, limit = 10, repo } = req.query;
  if (!q) return res.status(400).json({ success: false, error: 'q is required' });

  const lim = Math.min(parseInt(limit) || 10, 50);
  const params = [];
  let repoFilter = '';
  if (repo) {
    params.push(repo);
    repoFilter = `AND c.repo_name = $${params.length}`;
  }

  // Try vector search first
  let rows = [];
  let searchType = 'vector';

  try {
    const vec = await embedText(q);
    const vecStr = `[${vec.join(',')}]`;
    const result = await queryRows(
      `SELECT c.id, c.repo_name, c.relative_path, c.chunk_type, c.chunk_name,
              c.start_line, c.end_line,
              LEFT(c.content, 600) as content,
              1 - (c.embedding <=> '${vecStr}'::vector(768)) as similarity
       FROM cortex.code_chunks c
       WHERE c.embedding IS NOT NULL ${repoFilter}
       ORDER BY c.embedding <=> '${vecStr}'::vector(768)
       LIMIT ${lim}`,
      params
    );
    rows = result;
  } catch {
    searchType = 'text';
  }

  // Fallback to ILIKE if no vector results
  if (rows.length === 0) {
    searchType = 'text';
    params.length = 0;
    params.push(`%${q}%`);
    let textRepoFilter = '';
    if (repo) {
      params.push(repo);
      textRepoFilter = `AND c.repo_name = $${params.length}`;
    }
    rows = await queryRows(
      `SELECT c.id, c.repo_name, c.relative_path, c.chunk_type, c.chunk_name,
              c.start_line, c.end_line,
              LEFT(c.content, 600) as content,
              0.5 as similarity
       FROM cortex.code_chunks c
       WHERE c.content ILIKE $1 ${textRepoFilter}
       ORDER BY c.chunk_type, c.relative_path
       LIMIT ${lim}`,
      params
    );
  }

  res.json({ success: true, query: q, searchType, results: rows, count: rows.length });
}));

// ── GET /ext/topology ─────────────────────────────────────────────────────────
router.get('/ext/topology', requireAuth, asyncHandler(async (req, res) => {
  const cfg = getConfig();
  const nodes = [];
  const edges = [];

  // Repo nodes with stats
  const repoStats = await queryRows(
    `SELECT repo_name, COUNT(DISTINCT relative_path) as files, COUNT(*) as chunks
     FROM cortex.code_chunks GROUP BY repo_name`
  );
  const statsByRepo = Object.fromEntries(
    repoStats.map(r => [r.repo_name, r])
  );

  // Health by service
  let healthByService = {};
  try {
    const hRows = await queryRows(
      `SELECT DISTINCT ON (service_name) service_name, status, latency_ms
       FROM cortex.health_snapshots ORDER BY service_name, checked_at DESC`
    );
    healthByService = Object.fromEntries(hRows.map(r => [r.service_name, r]));
  } catch {}

  // Add repo nodes
  for (const repo of cfg.repos) {
    const stats = statsByRepo[repo.name] || {};

    // Determine health from services config
    const svcNames = Object.keys(repo.services || {});
    const svcStatuses = svcNames.map(s => healthByService[s]?.status || 'unknown');
    const health = svcStatuses.length === 0 ? 'unknown' :
                   svcStatuses.every(s => s === 'ok') ? 'healthy' :
                   svcStatuses.some(s => s === 'down') ? 'degraded' : 'unknown';
    nodes.push({
      id:    repo.name,
      type:  'repo',
      label: repo.name,
      health,
      path:  repo.path,
      stats: { files: parseInt(stats.files || 0), chunks: parseInt(stats.chunks || 0) },
    });

    // Add database nodes + repo->db edges
    for (const db of (repo.databases || [])) {
      const dbId = `${db.name || db.database}:${db.port || 5432}`;
      if (!nodes.find(n => n.id === dbId)) {
        nodes.push({ id: dbId, type: 'database', label: db.name || db.database, port: db.port || 5432, host: db.host });
      }
      edges.push({ from: repo.name, to: dbId, type: 'postgres', label: `reads/writes ${db.database}` });
    }

    // Add service nodes + repo->service edges
    for (const [svcName, svcCfg] of Object.entries(repo.services || {})) {
      const svcId = svcName.toLowerCase().replace(/\s+/g, '-');
      if (!nodes.find(n => n.id === svcId)) {
        const h = healthByService[svcName];
        nodes.push({
          id: svcId, type: 'service', label: svcName,
          health: h?.status || 'unknown',
          latencyMs: h?.latency_ms || null,
        });
      }
      edges.push({ from: repo.name, to: svcId, type: svcCfg.type || 'http', label: svcName });
    }
  }

  // Cross-repo edges from graph_edges with edge_type = 'cross_repo' (if any)
  try {
    const xEdges = await queryRows(
      `SELECT DISTINCT ge.repo_name as source, c2.repo_name as target, ge.edge_type, ge.label
       FROM cortex.graph_edges ge
       JOIN cortex.code_chunks c2 ON c2.id = ge.target_chunk_id
       WHERE ge.repo_name != c2.repo_name
       LIMIT 100`
    );
    for (const e of xEdges) {
      edges.push({ from: e.source, to: e.target, type: e.edge_type, label: e.label });
    }
  } catch {}

  res.json({ success: true, nodes, edges });
}));

// ── GET /ext/context?task=&depth=light|medium|deep&repo= ─────────────────────
router.get('/ext/context', requireAuth, asyncHandler(async (req, res) => {
  const { task, depth = 'medium', repo } = req.query;
  if (!task) return res.status(400).json({ success: false, error: 'task is required' });

  const params = [];
  let repoFilter = '';
  if (repo) {
    params.push(repo);
    repoFilter = `AND c.repo_name = $${params.length}`;
  }
  const limits = { light: 10, medium: 25, deep: 60 };
  const lim = limits[depth] || 25;

  // Search for relevant chunks
  let chunks = [];
  let searchType = 'text';

  try {
    const vec = await embedText(task);
    const vecStr = `[${vec.join(',')}]`;
    chunks = await queryRows(
      `SELECT c.repo_name, c.relative_path, c.chunk_type, c.chunk_name,
              c.start_line, c.end_line, c.language,
              c.meta,
              ${depth === 'deep' ? 'c.content' : 'LEFT(c.content, 800) as content'},
              1 - (c.embedding <=> '${vecStr}'::vector(768)) as similarity
       FROM cortex.code_chunks c
       WHERE c.embedding IS NOT NULL ${repoFilter}
       ORDER BY c.embedding <=> '${vecStr}'::vector(768)
       LIMIT ${lim}`,
      params
    );
    searchType = 'vector';
  } catch {}

  if (chunks.length === 0) {
    // Fallback to text search
    const terms = task.split(/\s+/).filter(t => t.length > 3).slice(0, 3);
    const textParams = [];
    const ilikeConditions = terms.map(t => {
      textParams.push(`%${t}%`);
      return `c.content ILIKE $${textParams.length}`;
    });
    const ilike = ilikeConditions.length > 0 ? ilikeConditions.join(' OR ') : `c.content ILIKE $1`;
    if (ilikeConditions.length === 0) textParams.push(`%${task}%`);
    if (repo) {
      textParams.push(repo);
    }
    const textRepoFilter = repo ? `AND c.repo_name = $${textParams.length}` : '';

    chunks = await queryRows(
      `SELECT c.repo_name, c.relative_path, c.chunk_type, c.chunk_name,
              c.start_line, c.end_line, c.language,
              c.meta,
              ${depth === 'deep' ? 'c.content' : 'LEFT(c.content, 800) as content'}
       FROM cortex.code_chunks c
       WHERE (${ilike}) ${textRepoFilter}
       ORDER BY c.updated_at DESC
       LIMIT ${lim}`,
      textParams
    );
  }

  // Get health snapshot (non-ok services)
  let healthLines = '';
  try {
    const hRows = await queryRows(
      `SELECT service_name, status, latency_ms FROM (
         SELECT DISTINCT ON (service_name) service_name, status, latency_ms
         FROM cortex.health_snapshots ORDER BY service_name, checked_at DESC
       ) s WHERE status != 'ok'`
    );
    if (hRows.length > 0) {
      healthLines = '\n## Service Issues\n' +
        hRows.map(r => `- **${r.service_name}**: ${r.status} (${r.latency_ms}ms)`).join('\n');
    }
  } catch {}

  // Extract metadata from chunks' meta JSONB
  const allTables = [...new Set(chunks.flatMap(c => c.meta?.db_tables || []))].slice(0, 20);
  const allEnvVars = [...new Set(chunks.flatMap(c => c.meta?.env_vars || []))].slice(0, 15);
  const allTodos = chunks.flatMap(c =>
    (c.meta?.todos || []).map(t => `${c.relative_path}: ${t}`)
  ).slice(0, 10);

  // Group by repo
  const byRepo = {};
  for (const chunk of chunks) {
    if (!byRepo[chunk.repo_name]) byRepo[chunk.repo_name] = [];
    byRepo[chunk.repo_name].push(chunk);
  }

  // Build markdown
  let md = `# Context: ${task}
_Generated by context-cortex | depth: ${depth} | search: ${searchType} | ${new Date().toISOString()}_
${healthLines}

## Relevant Files (${chunks.length} chunks across ${Object.keys(byRepo).length} repos)
`;

  for (const [repoName, repoChunks] of Object.entries(byRepo)) {
    md += `\n### ${repoName}\n`;
    for (const chunk of repoChunks) {
      const loc = chunk.relative_path
        ? `${chunk.relative_path.split('/').slice(-3).join('/')}:${chunk.start_line}`
        : 'unknown';
      const label = chunk.chunk_name ? ` — ${chunk.chunk_name}` : '';
      md += `\n#### \`${loc}\`${label} [${chunk.chunk_type || 'module'}]\n`;
      if (depth !== 'light' && chunk.content) {
        const lang = chunk.language ||
                     (chunk.relative_path?.endsWith('.py') ? 'python' :
                      chunk.relative_path?.match(/\.tsx?$/) ? 'typescript' : 'javascript');
        md += `\`\`\`${lang}\n${chunk.content}\n\`\`\`\n`;
      }
    }
  }

  if (allTables.length > 0) {
    md += `\n## Database Tables Referenced\n${allTables.map(t => `- \`${t}\``).join('\n')}\n`;
  }
  if (allEnvVars.length > 0) {
    md += `\n## Environment Variables\n${allEnvVars.map(v => `- \`${v}\``).join('\n')}\n`;
  }
  if (allTodos.length > 0) {
    md += `\n## Open TODOs\n${allTodos.map(t => `- ${t}`).join('\n')}\n`;
  }

  if (depth === 'deep') {
    md += `\n## How to Use This Context\n1. The files above are ranked by semantic relevance to: "${task}"\n2. Check DB tables referenced — changes may need migrations\n3. Verify env vars are set in .env before running\n4. Fix TODOs as part of this task if relevant\n`;
  }

  res.json({
    success: true,
    task,
    depth,
    searchType,
    chunkCount: chunks.length,
    repos: Object.keys(byRepo),
    markdown: md,
    meta: { tables: allTables, envVars: allEnvVars, todos: allTodos },
  });
}));

// ── GET /ext/errors?limit=50&operation=&repo= ────────────────────────────────
router.get('/ext/errors', requireAuth, asyncHandler(async (req, res) => {
  const { limit = 50, operation, repo } = req.query;
  const params = [];
  const conditions = [];

  if (operation) {
    params.push(operation);
    conditions.push(`operation = $${params.length}`);
  }
  if (repo) {
    params.push(repo);
    conditions.push(`repo_name = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const lim = Math.min(parseInt(limit) || 50, 200);
  params.push(lim);

  const rows = await queryRows(
    `SELECT id, created_at, repo_name, operation, error_code, message, file_path
     FROM cortex.errors ${where}
     ORDER BY created_at DESC
     LIMIT $${params.length}`,
    params
  );

  res.json({ success: true, errors: rows, count: rows.length });
}));

// ── POST /ext/errors — log an error ──────────────────────────────────────────
router.post('/ext/errors', requireAuth, asyncHandler(async (req, res) => {
  const { repoName, operation, filePath, errorCode, message, stack, meta } = req.body || {};
  if (!operation || !message) {
    return res.status(400).json({ success: false, error: 'operation and message are required' });
  }

  await logError({ repoName, operation, filePath, errorCode, message, stack, meta });
  res.json({ success: true });
}));

// ── POST /ext/errors/:id/resolve — soft-delete by removing from recent view ─
// Context-cortex errors table lacks a `resolved` column, so we delete the row.
router.post('/ext/errors/:id/resolve', requireAuth, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || isNaN(id)) {
    return res.status(400).json({ success: false, error: 'Invalid error ID' });
  }
  await query(`DELETE FROM cortex.errors WHERE id = $1`, [id]);
  res.json({ success: true });
}));

export default router;
