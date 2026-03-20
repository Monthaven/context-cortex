/**
 * src/dump/claude-md.js
 * Generates CLAUDE.md context files for repositories.
 *
 * Queries code_chunks, graph_edges, health_snapshots, table_ownership,
 * and work_log to produce a comprehensive, up-to-date CLAUDE.md for each repo.
 *
 * Features:
 *   - mergeIntoClaude() — inject between <!-- cortex-context-start/end --> markers
 *   - .cortex.CLAUDE.md backup alongside the primary CLAUDE.md
 *   - getCompactWorkLog() — work-log entries grouped by date/repo
 *   - sessionProtocol() — curl commands for session start/end
 *   - Top-N files by chunk count
 *   - Service health, graph stats, recent errors
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { queryRows, queryOne } from '../db/connection.js';
import { getConfig, getRepoConfig } from '../config.js';

// ---------------------------------------------------------------------------
// Markers for CLAUDE.md injection
// ---------------------------------------------------------------------------

const MARKER_START = '<!-- cortex-context-start -->';
const MARKER_END   = '<!-- cortex-context-end -->';

/**
 * Merge cortex content into an existing CLAUDE.md.
 * Replaces between markers if present; otherwise appends.
 */
function mergeIntoClaude(existingPath, cortexContent, apiKey, port) {
  const refreshCmd = `curl -s -X POST http://localhost:${port}/dump/claude-md -H "X-API-Key: ${apiKey}"`;
  const block = `
${MARKER_START}
<!-- Auto-injected by context-cortex. Regenerated every 4 hours or on demand. -->
<!-- To refresh: ${refreshCmd} -->

${cortexContent}

${MARKER_END}`;

  let existing = '';
  if (existsSync(existingPath)) {
    existing = readFileSync(existingPath, 'utf8');
  }

  const startIdx = existing.indexOf(MARKER_START);
  const endIdx   = existing.indexOf(MARKER_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    // Replace between markers
    return existing.slice(0, startIdx).trimEnd() + block + '\n';
  }
  // Append
  return (existing.trimEnd() + '\n' + block + '\n');
}

// ---------------------------------------------------------------------------
// Work Log helpers
// ---------------------------------------------------------------------------

function pgEscMd(str) {
  if (!str) return 'NULL';
  return `'${String(str).replace(/'/g, "''")}'`;
}

/**
 * Fetch compact work log markdown for injection into CLAUDE.md.
 * @param {string|null} repo  — if null, returns all repos
 * @param {number} days
 */
async function getCompactWorkLog(repo, days = 7) {
  try {
    let where = `occurred_at > NOW() - INTERVAL '${days} days'`;
    if (repo) where += ` AND repo = ${pgEscMd(repo)}`;

    const entries = await queryRows(`
      SELECT repo, occurred_at, category, summary, status, result, commit_hash
      FROM cortex.work_log
      WHERE ${where}
      ORDER BY occurred_at DESC
      LIMIT 150
    `);

    const inProgress = await queryRows(
      `SELECT repo, occurred_at, category, summary, result
       FROM cortex.work_log WHERE status = 'in_progress' ORDER BY occurred_at DESC LIMIT 10`
    );

    if (entries.length === 0 && inProgress.length === 0) {
      return '_No work logged yet. POST /work-log to start tracking._';
    }

    const now = new Date();
    const todayStr     = now.toISOString().slice(0, 10);
    const yesterdayStr = new Date(now - 86400000).toISOString().slice(0, 10);

    const byDate = {};
    for (const e of entries) {
      if (e.status === 'in_progress') continue;
      const d = new Date(e.occurred_at).toISOString().slice(0, 10);
      if (!byDate[d]) byDate[d] = {};
      if (!byDate[d][e.repo]) byDate[d][e.repo] = [];
      byDate[d][e.repo].push(e);
    }

    const lines = [];
    const MAX = 45;
    for (const date of Object.keys(byDate).sort().reverse()) {
      if (lines.length >= MAX - 4) break;
      const label = date === todayStr ? `### ${date} (today)`
        : date === yesterdayStr ? `### ${date} (yesterday)`
        : `### ${date}`;
      lines.push(label);
      for (const [rName, rEntries] of Object.entries(byDate[date])) {
        if (lines.length >= MAX - 2) break;
        if (!repo) lines.push(`**${rName}:**`);
        for (const e of rEntries) {
          if (lines.length >= MAX - 1) break;
          const hash = e.commit_hash ? ` (${String(e.commit_hash).slice(0, 7)})` : '';
          const outcome = e.result ? ` → ${e.result}` : '';
          lines.push(`- [${e.category}] ${e.summary}${outcome}${hash}`);
        }
      }
      lines.push('');
    }

    if (inProgress.length > 0) {
      lines.push('### In Progress');
      for (const e of inProgress.slice(0, 6)) {
        const detail = e.result ? ` — ${e.result}` : '';
        lines.push(`- [${e.category}${!repo ? '/' + e.repo : ''}] ${e.summary}${detail}`);
      }
    }

    return lines.join('\n');
  } catch (err) {
    return `_Work log unavailable: ${err.message}_`;
  }
}

/**
 * Build the session protocol block for a repo's CLAUDE.md.
 */
function sessionProtocol(repoName, apiKey, port) {
  const key = apiKey || 'YOUR_API_KEY';
  const base = `http://localhost:${port}`;
  return `\`\`\`bash
# SESSION START — run this first every time you start work
# Returns a session_id — save it for session-end
curl -s -X POST ${base}/work-log/session-start \\
  -H "X-API-Key: ${key}" -H "Content-Type: application/json" \\
  -d '{"repo":"${repoName}","summary":"DESCRIBE_YOUR_TASK_HERE"}'
# Response: { "success": true, "session_id": "2026-03-20-a1b2c3", "id": 42 }

# LOG SIGNIFICANT CHANGES as you work
curl -s -X POST ${base}/work-log \\
  -H "X-API-Key: ${key}" -H "Content-Type: application/json" \\
  -d '{"repo":"${repoName}","category":"build","summary":"WHAT_YOU_DID","files_touched":["file.js"],"status":"completed"}'

# SESSION END — pass the session_id from session-start
curl -s -X POST ${base}/work-log/session-end \\
  -H "X-API-Key: ${key}" -H "Content-Type: application/json" \\
  -d '{"session_id":"SESSION_ID_FROM_START","summary":"WHAT_YOU_DID","result":"OUTCOME"}'
\`\`\`
_Note: Replace YOUR_API_KEY with the CORTEX_API_KEY env var._
_The session_id returned by session-start must be passed to session-end to close the session._`;
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

async function getChunkStats(repoName) {
  return queryOne(
    `SELECT
       COUNT(*) AS total_chunks,
       COUNT(DISTINCT relative_path) AS total_files,
       COUNT(DISTINCT language) AS languages_count,
       SUM(token_estimate) AS total_tokens,
       MAX(updated_at) AS last_scanned
     FROM cortex.code_chunks
     WHERE repo_name = $1`,
    [repoName]
  );
}

async function getTopFiles(repoName, limit) {
  return queryRows(
    `SELECT relative_path, COUNT(*) AS chunk_count,
            SUM(token_estimate) AS token_count,
            MAX(language) AS language,
            MAX(updated_at) AS last_updated
     FROM cortex.code_chunks
     WHERE repo_name = $1
     GROUP BY relative_path
     ORDER BY chunk_count DESC
     LIMIT $2`,
    [repoName, limit]
  );
}

async function getLanguageBreakdown(repoName) {
  return queryRows(
    `SELECT language, COUNT(DISTINCT relative_path) AS file_count,
            COUNT(*) AS chunk_count
     FROM cortex.code_chunks
     WHERE repo_name = $1 AND language IS NOT NULL AND language != 'unknown'
     GROUP BY language
     ORDER BY file_count DESC`,
    [repoName]
  );
}

async function getRouteEdges(repoName, limit) {
  return queryRows(
    `SELECT ge.label AS route, sc.relative_path AS file
     FROM cortex.graph_edges ge
     JOIN cortex.code_chunks sc ON sc.id = ge.source_chunk_id
     WHERE ge.repo_name = $1 AND ge.edge_type = 'route'
     ORDER BY sc.relative_path, ge.label
     LIMIT $2`,
    [repoName, limit]
  );
}

async function getTableOwnership(repoName, limit) {
  return queryRows(
    `SELECT schema_name, table_name, access_type,
            array_length(detected_in, 1) AS reference_count
     FROM cortex.table_ownership
     WHERE repo_name = $1
     ORDER BY reference_count DESC NULLS LAST, table_name
     LIMIT $2`,
    [repoName, limit]
  );
}

async function getImportEdges(repoName) {
  return queryRows(
    `SELECT ge.label AS import_path, COUNT(*) AS usage_count
     FROM cortex.graph_edges ge
     WHERE ge.repo_name = $1 AND ge.edge_type = 'import'
       AND ge.label NOT LIKE '.%'   -- Skip relative imports
       AND ge.label NOT LIKE '/%'
     GROUP BY ge.label
     ORDER BY usage_count DESC
     LIMIT 20`,
    [repoName]
  );
}

async function getLatestHealth(repoName) {
  return queryRows(
    `SELECT DISTINCT ON (service_name)
       service_name, service_type, status, latency_ms, error_message, checked_at
     FROM cortex.health_snapshots
     WHERE repo_name = $1
     ORDER BY service_name, checked_at DESC`,
    [repoName]
  );
}

async function getRecentErrors(repoName) {
  return queryRows(
    `SELECT operation, file_path, message, created_at
     FROM cortex.errors
     WHERE repo_name = $1
     ORDER BY created_at DESC
     LIMIT 10`,
    [repoName]
  );
}

async function getKeyFunctions(repoName, limit) {
  return queryRows(
    `SELECT chunk_name, chunk_type, relative_path, token_estimate
     FROM cortex.code_chunks
     WHERE repo_name = $1
       AND chunk_type IN ('function', 'class', 'interface', 'route', 'type')
       AND chunk_name NOT IN ('chunk_1', 'chunk_2', 'chunk_3')
       AND chunk_name NOT LIKE 'chunk_%'
     ORDER BY token_estimate DESC
     LIMIT $2`,
    [repoName, limit]
  );
}

async function getGraphStats(repoName) {
  return queryOne(
    `SELECT
       COUNT(*) AS total_edges,
       COUNT(DISTINCT edge_type) AS edge_types,
       SUM(CASE WHEN edge_type = 'import' THEN 1 ELSE 0 END) AS import_edges,
       SUM(CASE WHEN edge_type = 'route' THEN 1 ELSE 0 END) AS route_edges,
       SUM(CASE WHEN edge_type = 'db_query' THEN 1 ELSE 0 END) AS db_edges
     FROM cortex.graph_edges
     WHERE repo_name = $1`,
    [repoName]
  );
}

async function getLastScanLog(repoName) {
  return queryOne(
    `SELECT status, scan_type, files_scanned, chunks_upserted, duration_ms, completed_at
     FROM cortex.scan_log
     WHERE repo_name = $1 AND status = 'completed'
     ORDER BY completed_at DESC
     LIMIT 1`,
    [repoName]
  );
}

// ---------------------------------------------------------------------------
// Markdown generation helpers
// ---------------------------------------------------------------------------

function formatDate(d) {
  if (!d) return 'never';
  const date = d instanceof Date ? d : new Date(d);
  return date.toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
}

function statusIcon(status) {
  const icons = { ok: '✓', degraded: '⚠', down: '✗', unknown: '?' };
  return icons[status] || '?';
}

// ---------------------------------------------------------------------------
// Main generator
// ---------------------------------------------------------------------------

/**
 * Generate CLAUDE.md markdown content for a repository.
 *
 * @param {object} repoConfig - Merged repo config
 * @returns {Promise<string>} Markdown content
 */
export async function generateClaudeMd(repoConfig) {
  const cfg = getConfig();
  const { name, description, path: repoPath, language } = repoConfig;
  const contextCfg = repoConfig.context;
  const port   = cfg.server?.port || 3131;
  const apiKey = cfg.server?.apiKey || '';

  const [
    stats,
    topFiles,
    languages,
    routes,
    tables,
    imports,
    health,
    errors,
    keyFunctions,
    graphStats,
    lastScan,
    recentWork,
    allWork,
  ] = await Promise.all([
    getChunkStats(name),
    getTopFiles(name, contextCfg.maxChunksInSummary || 20),
    getLanguageBreakdown(name),
    getRouteEdges(name, contextCfg.maxRoutesListed || 50),
    getTableOwnership(name, contextCfg.maxTablesListed || 30),
    getImportEdges(name),
    contextCfg.includeHealthSummary ? getLatestHealth(name) : Promise.resolve([]),
    getRecentErrors(name),
    getKeyFunctions(name, 30),
    contextCfg.includeGraphSummary ? getGraphStats(name) : Promise.resolve(null),
    getLastScanLog(name),
    getCompactWorkLog(name, 7),
    getCompactWorkLog(null, 3),
  ]);

  const lines = [];
  const now = new Date().toISOString().slice(0, 10);

  // ---------------------------------------------------------------------------
  // Header
  // ---------------------------------------------------------------------------
  lines.push(`# ${name} — Code Context`);
  lines.push('');
  lines.push(`> Auto-generated by [Context Cortex](https://github.com/context-cortex/context-cortex) on ${now}.`);
  lines.push('> Do not edit manually — regenerated every 4 hours or on demand.');
  lines.push('');
  lines.push('> **Context Cortex** is a code intelligence layer that auto-generates this context file.');
  lines.push('> It scans your codebase, tracks work history, and injects fresh context here every 4 hours');
  lines.push('> so Claude Code starts every session informed. Do not edit the section between the cortex markers manually.');
  lines.push('');

  if (description) {
    lines.push(`**Description:** ${description}`);
    lines.push('');
  }

  lines.push(`**Repository path:** \`${repoPath}\``);
  if (language) lines.push(`**Primary language:** ${language}`);
  lines.push('');

  // ---------------------------------------------------------------------------
  // Session Protocol
  // ---------------------------------------------------------------------------
  lines.push('## Session Protocol');
  lines.push(sessionProtocol(name, apiKey, port));
  lines.push('');

  // ---------------------------------------------------------------------------
  // Recent Work
  // ---------------------------------------------------------------------------
  lines.push(`## Recent Work — ${name} (last 7 days)`);
  lines.push(recentWork);
  lines.push('');

  lines.push('## System-Wide Recent Work (last 3 days)');
  lines.push(allWork);
  lines.push('');

  // ---------------------------------------------------------------------------
  // Scan summary
  // ---------------------------------------------------------------------------
  lines.push('## Scan Summary');
  lines.push('');

  if (stats) {
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Files scanned | ${stats.total_files || 0} |`);
    lines.push(`| Code chunks | ${stats.total_chunks || 0} |`);
    lines.push(`| Estimated tokens | ${Number(stats.total_tokens || 0).toLocaleString()} |`);
    lines.push(`| Languages detected | ${stats.languages_count || 0} |`);
    lines.push(`| Last scanned | ${formatDate(stats.last_scanned)} |`);
    if (lastScan) {
      lines.push(`| Last scan duration | ${lastScan.duration_ms}ms |`);
    }
  } else {
    lines.push('*No scan data available. Run `npm run scan` first.*');
  }

  lines.push('');

  // ---------------------------------------------------------------------------
  // Entry Points
  // ---------------------------------------------------------------------------
  const entryPoints = repoConfig.entryPoints || [];
  if (entryPoints.length > 0) {
    lines.push('## Entry Points');
    lines.push('');
    for (const ep of entryPoints) {
      lines.push(`- \`${ep}\``);
    }
    lines.push('');
  }

  // ---------------------------------------------------------------------------
  // Database Connections (from repo config)
  // ---------------------------------------------------------------------------
  const databases = repoConfig.databases || [];
  if (databases.length > 0) {
    lines.push('## Database Connections');
    lines.push('');
    lines.push('| Name | Host | Port | Database | Purpose |');
    lines.push('|------|------|------|----------|---------|');
    for (const db of databases) {
      lines.push(`| ${db.name || '—'} | ${db.host || 'localhost'} | ${db.port || '—'} | ${db.database || '—'} | ${db.purpose || '—'} |`);
    }
    lines.push('');
  }

  // ---------------------------------------------------------------------------
  // Language breakdown
  // ---------------------------------------------------------------------------
  if (languages.length > 0) {
    lines.push('## Language Breakdown');
    lines.push('');
    lines.push('| Language | Files | Chunks |');
    lines.push('|----------|-------|--------|');
    for (const lang of languages) {
      lines.push(`| ${lang.language} | ${lang.file_count} | ${lang.chunk_count} |`);
    }
    lines.push('');
  }

  // ---------------------------------------------------------------------------
  // Key files
  // ---------------------------------------------------------------------------
  if (topFiles.length > 0) {
    lines.push('## Key Files (by chunk density)');
    lines.push('');
    lines.push('| File | Chunks | Tokens | Language |');
    lines.push('|------|--------|--------|----------|');
    for (const f of topFiles) {
      lines.push(`| \`${f.relative_path}\` | ${f.chunk_count} | ${Number(f.token_count || 0).toLocaleString()} | ${f.language || '—'} |`);
    }
    lines.push('');
  }

  // ---------------------------------------------------------------------------
  // Key functions / classes
  // ---------------------------------------------------------------------------
  if (keyFunctions.length > 0) {
    lines.push('## Key Symbols');
    lines.push('');
    lines.push('Largest functions, classes, and types by token count:');
    lines.push('');
    lines.push('| Symbol | Type | File | Tokens |');
    lines.push('|--------|------|------|--------|');
    for (const fn of keyFunctions) {
      lines.push(`| \`${fn.chunk_name}\` | ${fn.chunk_type} | \`${fn.relative_path}\` | ${fn.token_estimate || 0} |`);
    }
    lines.push('');
  }

  // ---------------------------------------------------------------------------
  // API routes
  // ---------------------------------------------------------------------------
  if (routes.length > 0) {
    lines.push('## API Routes');
    lines.push('');
    lines.push('Detected from Express/FastAPI/Flask route definitions:');
    lines.push('');
    lines.push('| Route | Defined in |');
    lines.push('|-------|-----------|');
    for (const r of routes) {
      lines.push(`| \`${r.route}\` | \`${r.file}\` |`);
    }
    lines.push('');
  }

  // ---------------------------------------------------------------------------
  // Database tables
  // ---------------------------------------------------------------------------
  if (tables.length > 0) {
    lines.push('## Database Tables Referenced');
    lines.push('');
    lines.push('| Table | Schema | Access | References |');
    lines.push('|-------|--------|--------|-----------|');
    for (const t of tables) {
      lines.push(`| \`${t.table_name}\` | ${t.schema_name} | ${t.access_type} | ${t.reference_count || 1} |`);
    }
    lines.push('');
  }

  // ---------------------------------------------------------------------------
  // External dependencies (top imports)
  // ---------------------------------------------------------------------------
  if (imports.length > 0) {
    lines.push('## Top External Dependencies');
    lines.push('');
    lines.push('Most-imported external packages:');
    lines.push('');
    lines.push('| Package | Import count |');
    lines.push('|---------|-------------|');
    for (const imp of imports) {
      lines.push(`| \`${imp.import_path}\` | ${imp.usage_count} |`);
    }
    lines.push('');
  }

  // ---------------------------------------------------------------------------
  // Graph stats
  // ---------------------------------------------------------------------------
  if (contextCfg.includeGraphSummary && graphStats) {
    lines.push('## Knowledge Graph');
    lines.push('');
    lines.push('| Metric | Count |');
    lines.push('|--------|-------|');
    lines.push(`| Total edges | ${graphStats.total_edges || 0} |`);
    lines.push(`| Import edges | ${graphStats.import_edges || 0} |`);
    lines.push(`| Route edges | ${graphStats.route_edges || 0} |`);
    lines.push(`| DB query edges | ${graphStats.db_edges || 0} |`);
    lines.push('');
  }

  // ---------------------------------------------------------------------------
  // Health status
  // ---------------------------------------------------------------------------
  if (contextCfg.includeHealthSummary && health.length > 0) {
    lines.push('## Service Health');
    lines.push('');
    lines.push('| Service | Type | Status | Latency | Last Checked |');
    lines.push('|---------|------|--------|---------|-------------|');
    for (const h of health) {
      const icon = statusIcon(h.status);
      const latency = h.latency_ms != null ? `${h.latency_ms}ms` : '—';
      lines.push(`| ${h.service_name} | ${h.service_type} | ${icon} ${h.status} | ${latency} | ${formatDate(h.checked_at)} |`);
    }
    lines.push('');
    if (health.some(h => h.status !== 'ok')) {
      lines.push('**Degraded services:**');
      for (const h of health.filter(h => h.status !== 'ok')) {
        lines.push(`- **${h.service_name}**: ${h.error_message || h.status}`);
      }
      lines.push('');
    }
  } else if (contextCfg.includeHealthSummary) {
    lines.push('## Service Health');
    lines.push('');
    lines.push('*No health data available. Configure services in cortex.config.json and run `npm run health`.*');
    lines.push('');
  }

  // ---------------------------------------------------------------------------
  // Recent errors
  // ---------------------------------------------------------------------------
  if (errors.length > 0) {
    lines.push('## Recent Scan Errors');
    lines.push('');
    lines.push('> These files had issues during the last scan. Review and fix if needed.');
    lines.push('');
    for (const e of errors) {
      lines.push(`- **${e.operation}** ${e.file_path ? `\`${e.file_path}\`` : ''}: ${e.message}`);
    }
    lines.push('');
  }

  // ---------------------------------------------------------------------------
  // Footer
  // ---------------------------------------------------------------------------
  lines.push('---');
  lines.push('');
  lines.push(`_Cortex API: http://localhost:${port} | Work log: GET http://localhost:${port}/work-log/compact_`);
  lines.push('');
  lines.push('*This file is auto-generated. Source: [Context Cortex](https://github.com/context-cortex/context-cortex)*');
  lines.push('');

  return lines.join('\n');
}

/**
 * Generate and write CLAUDE.md for a single repository.
 * Injects cortex content between markers in the existing CLAUDE.md.
 * Also writes a standalone .cortex.CLAUDE.md as backup.
 *
 * @param {object|string} repoConfigOrName - Repo config object or repo name string
 * @returns {Promise<string>} Path to written file
 */
export async function writeClaudeMd(repoConfigOrName) {
  const cfg = getConfig();
  const repoConfig = typeof repoConfigOrName === 'string'
    ? getRepoConfig(repoConfigOrName)
    : repoConfigOrName;

  const { name, path: repoPath } = repoConfig;
  const apiKey = cfg.server?.apiKey || '';
  const port   = cfg.server?.port || 3131;

  console.log(`[cortex:dump] Generating CLAUDE.md for ${name}...`);

  const content = await generateClaudeMd(repoConfig);

  // 1. Backup: write standalone .cortex.CLAUDE.md
  const backupPath = join(repoPath, '.cortex.CLAUDE.md');
  mkdirSync(dirname(backupPath), { recursive: true });
  writeFileSync(backupPath, content, 'utf8');

  // 2. Primary: inject/update cortex section in CLAUDE.md
  const claudePath = join(repoPath, 'CLAUDE.md');
  const merged = mergeIntoClaude(claudePath, content, apiKey, port);
  writeFileSync(claudePath, merged, 'utf8');

  console.log(`[cortex:dump] Injected into ${claudePath}`);
  return claudePath;
}

/**
 * Dump CLAUDE.md for all configured repos.
 * Called by auto-dump timer and the /dump/claude-md endpoint.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun] - Return content without writing files
 * @returns {Promise<{ written: string[], content: Record<string, string> }>}
 */
export async function dumpClaudeMd(opts = {}) {
  const cfg = getConfig();
  const written = [];
  const content = {};

  for (const repo of cfg.repos) {
    try {
      const md = await generateClaudeMd(repo);
      content[repo.name] = md;

      if (!opts.dryRun) {
        const apiKey = cfg.server?.apiKey || '';
        const port   = cfg.server?.port || 3131;

        // Backup: write standalone .cortex.CLAUDE.md
        const backupPath = join(repo.path, '.cortex.CLAUDE.md');
        mkdirSync(dirname(backupPath), { recursive: true });
        writeFileSync(backupPath, md, 'utf8');

        // Primary: inject/update cortex section in CLAUDE.md
        const claudePath = join(repo.path, 'CLAUDE.md');
        const merged = mergeIntoClaude(claudePath, md, apiKey, port);
        writeFileSync(claudePath, merged, 'utf8');
        written.push(claudePath);
        console.log(`[cortex:dump] Injected into ${claudePath}`);
      }
    } catch (err) {
      console.error(`[cortex:dump] Failed for ${repo.name}: ${err.message}`);
    }
  }

  return { written, content };
}
