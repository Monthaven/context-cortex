#!/usr/bin/env node

/**
 * mcp-server.js — Context Cortex MCP Server
 *
 * Standalone stdio MCP server that exposes all cortex functionality
 * as Claude Code tools. Communicates via stdin/stdout JSON-RPC.
 *
 * Usage:
 *   node mcp-server.js
 *
 * Claude Code spawns this as a subprocess. Configure in .mcp.json:
 *   { "mcpServers": { "context-cortex": { "command": "node", "args": ["S:/context-cortex/mcp-server.js"] } } }
 */

import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { getConfig } from './src/config.js';
import { getPool, query, queryOne, queryRows, runSchema } from './src/db/connection.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Embed text via Ollama (same logic as extended-routes.js) */
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

/** Format result as MCP text content */
function textResult(data) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text', text }] };
}

/** Format error as MCP error content */
function errorResult(message) {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

// ---------------------------------------------------------------------------
// Ensure decisions + gotchas tables exist (lazy, once per process)
// ---------------------------------------------------------------------------

let _tablesEnsured = false;

async function ensureExtraTables() {
  if (_tablesEnsured) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS cortex.decisions (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        decision TEXT NOT NULL,
        reasoning TEXT,
        affected_paths TEXT[] DEFAULT '{}',
        tags TEXT[] DEFAULT '{}',
        superseded_by INTEGER REFERENCES cortex.decisions(id),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS cortex.gotchas (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        solution TEXT,
        severity TEXT DEFAULT 'warning',
        affected_paths TEXT[] DEFAULT '{}',
        resolved_at TIMESTAMPTZ,
        resolution TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    _tablesEnsured = true;
  } catch (err) {
    console.error(`[cortex:mcp] ensureExtraTables failed: ${err.message}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const allTools = [
  // 1. cortex_search
  {
    name: 'cortex_search',
    description:
      'Semantic vector search across all indexed code chunks. Returns the most relevant code snippets for a natural language query.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language search query' },
        repo: { type: 'string', description: 'Filter to a specific repo name (optional)' },
        limit: { type: 'number', description: 'Max results to return (default 10, max 50)' },
      },
      required: ['query'],
    },
  },
  // 2. cortex_file_context
  {
    name: 'cortex_file_context',
    description:
      'Get context for specific file paths. Returns file summaries, chunk content, and metadata. Call this before working on files.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'File paths (relative or absolute) to get context for',
        },
        depth: {
          type: 'string',
          enum: ['light', 'medium', 'deep'],
          description: 'How much detail to return (default: medium)',
        },
      },
      required: ['paths'],
    },
  },
  // 3. cortex_system_status
  {
    name: 'cortex_system_status',
    description:
      'System health overview: chunk counts, embedding coverage, service health, recent errors.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  // 4. cortex_session_start
  {
    name: 'cortex_session_start',
    description: 'Start a work session. Returns a session_id for tracking.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository name' },
        summary: { type: 'string', description: 'Brief description of the task' },
      },
      required: ['repo', 'summary'],
    },
  },
  // 5. cortex_session_end
  {
    name: 'cortex_session_end',
    description: 'End a work session.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session ID from cortex_session_start' },
        summary: { type: 'string', description: 'Summary of what was done' },
        result: { type: 'string', description: 'Outcome of the session' },
      },
      required: ['session_id'],
    },
  },
  // 6. cortex_log_work
  {
    name: 'cortex_log_work',
    description: 'Log a work entry to the persistent work log.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository name' },
        category: {
          type: 'string',
          enum: ['build', 'fix', 'refactor', 'debug', 'deploy', 'config', 'feature', 'test', 'error', 'change'],
          description: 'Work category',
        },
        summary: { type: 'string', description: 'What was done' },
        files_touched: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files that were modified',
        },
        commit_hash: { type: 'string', description: 'Git commit hash if applicable' },
      },
      required: ['repo', 'summary'],
    },
  },
  // 7. cortex_recent_work
  {
    name: 'cortex_recent_work',
    description: 'Get recent work log entries as compact markdown.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Filter to a specific repo (optional)' },
        days: { type: 'number', description: 'How many days back to look (default 7, max 30)' },
      },
    },
  },
  // 8. cortex_log_decision
  {
    name: 'cortex_log_decision',
    description:
      'Record an architectural or design decision. Use when choosing between approaches, selecting patterns, or making tradeoffs.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title for the decision' },
        decision: { type: 'string', description: 'What was decided' },
        reasoning: { type: 'string', description: 'Why this choice was made' },
        affected_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files or paths affected by this decision',
        },
      },
      required: ['title', 'decision'],
    },
  },
  // 9. cortex_log_gotcha
  {
    name: 'cortex_log_gotcha',
    description:
      'Record a trap, edge case, or unexpected behavior. Future sessions will see this warning.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short warning title' },
        description: { type: 'string', description: 'What goes wrong or is unexpected' },
        solution: { type: 'string', description: 'How to avoid or fix it' },
        severity: {
          type: 'string',
          enum: ['critical', 'warning', 'info'],
          description: 'How serious this is (default: warning)',
        },
        affected_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files or paths where this gotcha applies',
        },
      },
      required: ['title', 'description'],
    },
  },
  // 10. cortex_get_decisions
  {
    name: 'cortex_get_decisions',
    description: 'List past architectural decisions. Optionally filter by search text.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search text to filter decisions (optional)' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
    },
  },
  // 11. cortex_get_gotchas
  {
    name: 'cortex_get_gotchas',
    description: 'List known traps and edge cases. Optionally filter by severity or search text.',
    inputSchema: {
      type: 'object',
      properties: {
        severity: {
          type: 'string',
          enum: ['critical', 'warning', 'info'],
          description: 'Filter by severity (optional)',
        },
        search: { type: 'string', description: 'Search text to filter gotchas (optional)' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
    },
  },
  // 12. cortex_resolve_gotcha
  {
    name: 'cortex_resolve_gotcha',
    description: 'Mark a gotcha as resolved/fixed.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Gotcha ID to resolve' },
        resolution: { type: 'string', description: 'How the gotcha was resolved' },
      },
      required: ['id', 'resolution'],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function handleTool(name, args) {
  switch (name) {
    // ── cortex_search ──────────────────────────────────────────────────
    case 'cortex_search': {
      const { query: q, repo, limit = 10 } = args;
      if (!q) return errorResult('query is required');

      const lim = Math.min(parseInt(limit) || 10, 50);
      const params = [];
      let repoFilter = '';
      if (repo) {
        params.push(repo);
        repoFilter = `AND c.repo_name = $${params.length}`;
      }

      let rows = [];
      let searchType = 'vector';

      try {
        const vec = await embedText(q);
        const vecStr = `[${vec.join(',')}]`;
        rows = await queryRows(
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
      } catch {
        searchType = 'text';
      }

      // Fallback to ILIKE
      if (rows.length === 0) {
        searchType = 'text';
        const textParams = [`%${q}%`];
        let textRepoFilter = '';
        if (repo) {
          textParams.push(repo);
          textRepoFilter = `AND c.repo_name = $${textParams.length}`;
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
          textParams
        );
      }

      return textResult({ searchType, count: rows.length, results: rows });
    }

    // ── cortex_file_context ────────────────────────────────────────────
    case 'cortex_file_context': {
      const { paths, depth = 'medium' } = args;
      if (!paths || !Array.isArray(paths) || paths.length === 0) {
        return errorResult('paths array is required');
      }

      const contentLength = depth === 'light' ? 400 : depth === 'deep' ? 0 : 800;
      const contentCol = contentLength > 0 ? `LEFT(c.content, ${contentLength})` : 'c.content';

      // Build ILIKE conditions for each path
      const conditions = paths.map((_, i) => `c.relative_path ILIKE $${i + 1}`);
      const params = paths.map(p => {
        // Support both absolute and relative paths
        const normalized = p.replace(/\\/g, '/');
        // Extract the relative portion (last N segments)
        const parts = normalized.split('/');
        const tail = parts.slice(-3).join('/');
        return `%${tail}%`;
      });

      const chunks = await queryRows(
        `SELECT c.repo_name, c.relative_path, c.chunk_type, c.chunk_name,
                c.start_line, c.end_line, c.language, c.meta,
                ${contentCol} as content
         FROM cortex.code_chunks c
         WHERE ${conditions.join(' OR ')}
         ORDER BY c.relative_path, c.start_line
         LIMIT 100`,
        params
      );

      // Also fetch related decisions and gotchas
      const decisionConditions = paths.map((_, i) => `$${i + 1} = ANY(affected_paths)`);
      const gotchaConditions = paths.map((_, i) => `$${i + 1} = ANY(affected_paths)`);

      let decisions = [];
      let gotchas = [];
      try {
        // Use the original paths for exact matching
        const pathParams = paths.map(p => p.replace(/\\/g, '/'));
        if (pathParams.length > 0) {
          decisions = await queryRows(
            `SELECT id, title, decision, reasoning, created_at
             FROM cortex.decisions
             WHERE ${pathParams.map((_, i) => `$${i + 1} = ANY(affected_paths)`).join(' OR ')}
             ORDER BY created_at DESC LIMIT 10`,
            pathParams
          );
          gotchas = await queryRows(
            `SELECT id, title, description, solution, severity, resolved_at, created_at
             FROM cortex.gotchas
             WHERE resolved_at IS NULL
               AND (${pathParams.map((_, i) => `$${i + 1} = ANY(affected_paths)`).join(' OR ')})
             ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, created_at DESC
             LIMIT 10`,
            pathParams
          );
        }
      } catch {
        // Tables might not exist yet — that's ok
      }

      // Group by file
      const byFile = {};
      for (const chunk of chunks) {
        if (!byFile[chunk.relative_path]) byFile[chunk.relative_path] = [];
        byFile[chunk.relative_path].push(chunk);
      }

      return textResult({
        files: Object.keys(byFile).length,
        chunks: chunks.length,
        byFile,
        decisions,
        gotchas,
      });
    }

    // ── cortex_system_status ───────────────────────────────────────────
    case 'cortex_system_status': {
      const [codebase, health, embeddings, scan, errCount] = await Promise.allSettled([
        queryOne(
          `SELECT COUNT(DISTINCT relative_path) as files,
                  COUNT(*) as chunks,
                  COUNT(*) FILTER (WHERE chunk_type = 'route') as routes,
                  COUNT(DISTINCT repo_name) as repos
           FROM cortex.code_chunks`
        ),
        queryOne(
          `SELECT COUNT(*) FILTER (WHERE status = 'ok') as up,
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
      const h = health.status === 'fulfilled' ? health.value || {} : {};
      const em = embeddings.status === 'fulfilled' ? embeddings.value || {} : {};
      const sc = scan.status === 'fulfilled' ? scan.value || {} : {};
      const er = errCount.status === 'fulfilled' ? errCount.value || {} : {};

      const totalChunks = parseInt(em.total || 0);
      const embeddedChunks = parseInt(em.embedded || 0);

      return textResult({
        codebase: {
          repos: parseInt(cb.repos || 0),
          files: parseInt(cb.files || 0),
          chunks: parseInt(cb.chunks || 0),
          routes: parseInt(cb.routes || 0),
        },
        services: {
          up: parseInt(h.up || 0),
          down: parseInt(h.down || 0),
          degraded: parseInt(h.degraded || 0),
          total: parseInt(h.total || 0),
          lastChecked: h.last_checked || null,
        },
        embeddings: {
          total: totalChunks,
          embedded: embeddedChunks,
          missing: totalChunks - embeddedChunks,
          coveragePct: totalChunks > 0 ? Math.round((embeddedChunks / totalChunks) * 100) : 0,
        },
        errors: { recent7d: parseInt(er.cnt || 0) },
        lastScan: sc.last_scan || null,
      });
    }

    // ── cortex_session_start ───────────────────────────────────────────
    case 'cortex_session_start': {
      const { repo, summary } = args;
      if (!repo) return errorResult('repo is required');
      if (!summary) return errorResult('summary is required');

      const sid = `${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`;

      const row = await queryOne(
        `INSERT INTO cortex.work_log
           (repo, session_id, category, summary, status, tags)
         VALUES ($1, $2, 'build', $3, 'in_progress', '{session}')
         RETURNING id`,
        [repo, sid, `SESSION START: ${summary}`]
      );

      return textResult({ session_id: sid, id: row?.id, message: `Session started for ${repo}` });
    }

    // ── cortex_session_end ─────────────────────────────────────────────
    case 'cortex_session_end': {
      const { session_id, summary, result } = args;
      if (!session_id) return errorResult('session_id is required');

      await query(
        `UPDATE cortex.work_log
         SET status = 'completed',
             result = $1,
             summary = $2
         WHERE session_id = $3 AND status = 'in_progress'`,
        [
          result || null,
          summary ? `SESSION END: ${summary}` : 'Session completed',
          session_id,
        ]
      );

      return textResult({ session_id, message: 'Session ended' });
    }

    // ── cortex_log_work ────────────────────────────────────────────────
    case 'cortex_log_work': {
      const { repo, category = 'build', summary, files_touched = [], commit_hash } = args;
      if (!repo) return errorResult('repo is required');
      if (!summary) return errorResult('summary is required');

      const validCategories = new Set([
        'build', 'fix', 'refactor', 'debug', 'deploy', 'config',
        'feature', 'test', 'error', 'change',
      ]);
      const cat = validCategories.has(category) ? category : 'build';

      const row = await queryOne(
        `INSERT INTO cortex.work_log
           (repo, category, summary, files_touched, status, commit_hash, tags)
         VALUES ($1, $2, $3, $4, 'completed', $5, '{}')
         ON CONFLICT (commit_hash) WHERE commit_hash IS NOT NULL DO NOTHING
         RETURNING id, occurred_at`,
        [repo, cat, summary, files_touched, commit_hash || null]
      );

      return textResult({ id: row?.id, occurred_at: row?.occurred_at, message: 'Work logged' });
    }

    // ── cortex_recent_work ─────────────────────────────────────────────
    case 'cortex_recent_work': {
      const { repo, days = 7 } = args;
      const dayCount = Math.min(parseInt(days) || 7, 30);

      const conditions = [`occurred_at > NOW() - $1::interval`];
      const params = [`${dayCount} days`];
      let idx = 1;

      if (repo) {
        params.push(repo);
        conditions.push(`repo = $${++idx}`);
      }

      const entries = await queryRows(
        `SELECT repo, session_id, occurred_at, category, summary,
                status, result, commit_hash, files_touched, tags
         FROM cortex.work_log
         WHERE ${conditions.join(' AND ')}
         ORDER BY occurred_at DESC
         LIMIT 200`,
        params
      );

      const inProgress = await queryRows(
        `SELECT id, repo, session_id, occurred_at, category, summary, result, tags
         FROM cortex.work_log WHERE status = 'in_progress' ORDER BY occurred_at DESC LIMIT 20`
      );

      if (entries.length === 0 && inProgress.length === 0) {
        return textResult('No work logged in the last ' + dayCount + ' days.');
      }

      // Group by date
      const byDate = {};
      const now = new Date();
      const todayStr = now.toISOString().slice(0, 10);
      const yesterdayStr = new Date(now - 86400000).toISOString().slice(0, 10);

      for (const e of entries) {
        if (e.status === 'in_progress') continue;
        const d = new Date(e.occurred_at).toISOString().slice(0, 10);
        if (!byDate[d]) byDate[d] = {};
        if (!byDate[d][e.repo]) byDate[d][e.repo] = [];
        byDate[d][e.repo].push(e);
      }

      const lines = [`## Recent Work (last ${dayCount} days)\n`];
      for (const date of Object.keys(byDate).sort().reverse()) {
        const label = date === todayStr ? `### ${date} (today)`
          : date === yesterdayStr ? `### ${date} (yesterday)`
            : `### ${date}`;
        lines.push(label);
        for (const [repoName, repoEntries] of Object.entries(byDate[date])) {
          lines.push(`**${repoName}:**`);
          for (const e of repoEntries) {
            const hash = e.commit_hash ? ` (${e.commit_hash.slice(0, 7)})` : '';
            const outcome = e.result ? ` -> ${e.result}` : '';
            lines.push(`- [${e.category}] ${e.summary}${outcome}${hash}`);
          }
        }
        lines.push('');
      }

      if (inProgress.length > 0) {
        lines.push('### In Progress');
        for (const e of inProgress.slice(0, 8)) {
          const detail = e.result ? ` -- ${e.result}` : '';
          lines.push(`- [${e.category}/${e.repo}] ${e.summary}${detail}`);
        }
      }

      return textResult(lines.join('\n'));
    }

    // ── cortex_log_decision ────────────────────────────────────────────
    case 'cortex_log_decision': {
      const { title, decision, reasoning, affected_paths = [] } = args;
      if (!title) return errorResult('title is required');
      if (!decision) return errorResult('decision is required');

      await ensureExtraTables();
      const row = await queryOne(
        `INSERT INTO cortex.decisions (title, decision, reasoning, affected_paths)
         VALUES ($1, $2, $3, $4)
         RETURNING id, created_at`,
        [title, decision, reasoning || null, affected_paths]
      );

      return textResult({ id: row?.id, created_at: row?.created_at, message: `Decision logged: ${title}` });
    }

    // ── cortex_log_gotcha ──────────────────────────────────────────────
    case 'cortex_log_gotcha': {
      const { title, description, solution, severity = 'warning', affected_paths = [] } = args;
      if (!title) return errorResult('title is required');
      if (!description) return errorResult('description is required');

      await ensureExtraTables();
      const row = await queryOne(
        `INSERT INTO cortex.gotchas (title, description, solution, severity, affected_paths)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, created_at`,
        [title, description, solution || null, severity, affected_paths]
      );

      return textResult({ id: row?.id, created_at: row?.created_at, message: `Gotcha logged: ${title}` });
    }

    // ── cortex_get_decisions ───────────────────────────────────────────
    case 'cortex_get_decisions': {
      const { search, limit = 10 } = args;
      const lim = Math.min(parseInt(limit) || 10, 50);

      await ensureExtraTables();
      let rows;
      if (search) {
        rows = await queryRows(
          `SELECT id, title, decision, reasoning, affected_paths, tags, superseded_by, created_at
           FROM cortex.decisions
           WHERE title ILIKE $1 OR decision ILIKE $1 OR reasoning ILIKE $1
           ORDER BY created_at DESC
           LIMIT $2`,
          [`%${search}%`, lim]
        );
      } else {
        rows = await queryRows(
          `SELECT id, title, decision, reasoning, affected_paths, tags, superseded_by, created_at
           FROM cortex.decisions
           ORDER BY created_at DESC
           LIMIT $1`,
          [lim]
        );
      }

      return textResult({ count: rows.length, decisions: rows });
    }

    // ── cortex_get_gotchas ─────────────────────────────────────────────
    case 'cortex_get_gotchas': {
      const { severity, search, limit = 10 } = args;
      const lim = Math.min(parseInt(limit) || 10, 50);

      await ensureExtraTables();
      const conditions = [];
      const params = [];

      if (severity) {
        params.push(severity);
        conditions.push(`severity = $${params.length}`);
      }
      if (search) {
        params.push(`%${search}%`);
        conditions.push(`(title ILIKE $${params.length} OR description ILIKE $${params.length})`);
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      params.push(lim);

      const rows = await queryRows(
        `SELECT id, title, description, solution, severity, affected_paths,
                resolved_at, resolution, created_at
         FROM cortex.gotchas
         ${where}
         ORDER BY
           CASE WHEN resolved_at IS NULL THEN 0 ELSE 1 END,
           CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
           created_at DESC
         LIMIT $${params.length}`,
        params
      );

      return textResult({ count: rows.length, gotchas: rows });
    }

    // ── cortex_resolve_gotcha ──────────────────────────────────────────
    case 'cortex_resolve_gotcha': {
      const { id, resolution } = args;
      if (!id) return errorResult('id is required');
      if (!resolution) return errorResult('resolution is required');

      await ensureExtraTables();
      const result = await query(
        `UPDATE cortex.gotchas
         SET resolved_at = NOW(), resolution = $1
         WHERE id = $2 AND resolved_at IS NULL`,
        [resolution, id]
      );

      if (result.rowCount === 0) {
        return errorResult(`Gotcha ${id} not found or already resolved`);
      }

      return textResult({ id, message: `Gotcha ${id} resolved` });
    }

    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// MCP server setup
// ---------------------------------------------------------------------------

const server = new Server(
  { name: 'context-cortex', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

// List tools handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: allTools };
});

// Call tool handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    return await handleTool(name, args || {});
  } catch (err) {
    return errorResult(err.message || String(err));
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  // Don't eagerly connect to DB — let it happen lazily on first tool call.
  // This ensures the MCP server starts and lists tools even if DB is unreachable.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[cortex:mcp] Context Cortex MCP server started (stdio)');
}

main().catch((err) => {
  console.error(`[cortex:mcp] Fatal error: ${err.message}`);
  process.exit(1);
});
