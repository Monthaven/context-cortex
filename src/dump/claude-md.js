/**
 * src/dump/claude-md.js
 * Generates CLAUDE.md context files for repositories.
 *
 * Queries code_chunks, graph_edges, health_snapshots, and table_ownership
 * to produce a comprehensive, up-to-date CLAUDE.md for each repo.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { queryRows, queryOne } from '../db/connection.js';
import { getConfig, getRepoConfig } from '../config.js';

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
  ]);

  const lines = [];
  const now = new Date().toISOString().slice(0, 10);

  // ---------------------------------------------------------------------------
  // Header
  // ---------------------------------------------------------------------------
  lines.push(`# ${name} — Code Context`);
  lines.push('');
  lines.push(`> Auto-generated by [Context Cortex](https://github.com/context-cortex/context-cortex) on ${now}.`);
  lines.push('> Do not edit manually — regenerate with: `node scripts/full-scan.js`');
  lines.push('');

  if (description) {
    lines.push(`**Description:** ${description}`);
    lines.push('');
  }

  lines.push(`**Repository path:** \`${repoPath}\``);
  if (language) lines.push(`**Primary language:** ${language}`);
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
  lines.push('*This file is auto-generated. Source: [Context Cortex](https://github.com/context-cortex/context-cortex)*');
  lines.push('');

  return lines.join('\n');
}

/**
 * Generate and write CLAUDE.md for a repository.
 * Writes to the path specified in repoConfig.context.outputPath,
 * or falls back to repoConfig.path/CLAUDE.md.
 *
 * @param {object|string} repoConfigOrName - Repo config object or repo name string
 * @returns {Promise<string>} Path to written file
 */
export async function writeClaudeMd(repoConfigOrName) {
  const cfg = getConfig();
  const repoConfig = typeof repoConfigOrName === 'string'
    ? getRepoConfig(repoConfigOrName)
    : repoConfigOrName;

  const { name, path: repoPath, context: contextCfg } = repoConfig;
  const outputPath = contextCfg?.outputPath
    || join(repoPath, contextCfg?.outputFileName || 'CLAUDE.md');

  console.log(`[cortex:dump] Generating CLAUDE.md for ${name}...`);

  const content = await generateClaudeMd(repoConfig);

  // Ensure directory exists
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, content, 'utf8');

  console.log(`[cortex:dump] Wrote ${content.length} bytes to: ${outputPath}`);
  return outputPath;
}
