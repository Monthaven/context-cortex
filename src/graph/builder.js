/**
 * src/graph/builder.js
 * Builds a knowledge graph of edges from code_chunks.
 *
 * Detects and creates edges for:
 *   - imports    (import/require statements → target module)
 *   - routes     (Express/Fastify router.get/post/etc definitions)
 *   - db_queries (SQL table references in code)
 *   - calls      (function call detection — heuristic)
 *
 * Edges are written to cortex.graph_edges.
 * Table references also update cortex.table_ownership.
 */

import { query, queryRows, withTransaction, logError } from '../db/connection.js';

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

// Import/require statements
const IMPORT_PATTERNS = [
  // ES module: import X from 'module'
  /^\s*import\s+.*\s+from\s+['"]([^'"]+)['"]/m,
  // Dynamic: import('module')
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  // CommonJS: require('module')
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  // Python: import module / from module import
  /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/m,
];

// Express/Fastify route definitions
const ROUTE_PATTERNS = [
  // router.get('/path', ...)  or  app.post('/path', ...)
  /(?:router|app|server)\s*\.\s*(get|post|put|patch|delete|all|use)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
  // Flask: @app.route('/path')
  /@(?:app|blueprint)\s*\.\s*route\s*\(\s*['"]([^'"]+)['"]/gi,
  // FastAPI: @router.get('/path')
  /@(?:router|app)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/gi,
];

// SQL table references
const SQL_TABLE_PATTERNS = [
  // FROM table_name, JOIN table_name
  /\b(?:FROM|JOIN)\s+(?:"?(\w+)"?\."?(\w+)"?|"?(\w+)"?)\b/gi,
  // INSERT INTO table_name
  /\bINSERT\s+INTO\s+(?:"?(\w+)"?\."?(\w+)"?|"?(\w+)"?)\b/gi,
  // UPDATE table_name
  /\bUPDATE\s+(?:"?(\w+)"?\."?(\w+)"?|"?(\w+)"?)\b/gi,
  // DELETE FROM table_name
  /\bDELETE\s+FROM\s+(?:"?(\w+)"?\."?(\w+)"?|"?(\w+)"?)\b/gi,
  // CREATE TABLE
  /\bCREATE\s+(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?(\w+)"?\."?(\w+)"?|"?(\w+)"?)\b/gi,
];

// Common SQL keywords / system tables to skip
const SQL_SKIP_TABLES = new Set([
  'select', 'where', 'order', 'group', 'having', 'limit', 'offset',
  'by', 'on', 'as', 'and', 'or', 'not', 'in', 'is', 'null', 'true', 'false',
  'case', 'when', 'then', 'else', 'end', 'coalesce', 'nullif',
  'information_schema', 'pg_catalog', 'pg_tables', 'pg_indexes',
]);

// ---------------------------------------------------------------------------
// Edge extractors
// ---------------------------------------------------------------------------

function extractImports(content, language) {
  const results = [];
  const lines = content.split('\n');

  for (const line of lines) {
    // ES module
    const esMatch = line.match(/^\s*import\s+.*\s+from\s+['"]([^'"]+)['"]/);
    if (esMatch) {
      results.push({ type: 'import', label: esMatch[1] });
      continue;
    }

    // Dynamic import
    const dynMatches = [...line.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)];
    for (const m of dynMatches) {
      results.push({ type: 'import', label: m[1] });
    }

    // CommonJS
    const cjsMatches = [...line.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)];
    for (const m of cjsMatches) {
      results.push({ type: 'import', label: m[1] });
    }

    // Python
    if (language === 'python') {
      const pyFrom = line.match(/^\s*from\s+([\w.]+)\s+import/);
      if (pyFrom) results.push({ type: 'import', label: pyFrom[1] });
      const pyImport = line.match(/^\s*import\s+([\w.]+)/);
      if (pyImport) results.push({ type: 'import', label: pyImport[1] });
    }
  }

  return results;
}

function extractRoutes(content) {
  const results = [];

  // Express/Fastify
  const routeMatches = [...content.matchAll(
    /(?:router|app|server)\s*\.\s*(get|post|put|patch|delete|all|use)\s*\(\s*['"`]([^'"`]+)['"`]/gi
  )];
  for (const m of routeMatches) {
    results.push({ type: 'route', label: `${m[1].toUpperCase()} ${m[2]}` });
  }

  // Flask/FastAPI decorators
  const decoratorMatches = [...content.matchAll(
    /@(?:router|app|blueprint)\s*\.\s*(get|post|put|patch|delete|route)\s*\(\s*['"]([^'"]+)['"]/gi
  )];
  for (const m of decoratorMatches) {
    results.push({ type: 'route', label: `${m[1].toUpperCase()} ${m[2]}` });
  }

  return results;
}

function extractSqlTables(content) {
  const results = [];
  const seen = new Set();

  for (const pattern of SQL_TABLE_PATTERNS) {
    const matches = [...content.matchAll(pattern)];
    for (const m of matches) {
      // Groups vary by pattern: try schema.table then just table
      let schema = null;
      let table = null;

      if (m[1] && m[2]) {
        schema = m[1].toLowerCase();
        table = m[2].toLowerCase();
      } else if (m[3]) {
        table = m[3].toLowerCase();
      } else if (m[1]) {
        table = m[1].toLowerCase();
      }

      if (!table) continue;
      if (SQL_SKIP_TABLES.has(table)) continue;
      if (table.length < 2 || table.length > 100) continue;
      if (/^\d/.test(table)) continue; // Skip things that start with numbers

      const key = `${schema || 'public'}.${table}`;
      if (seen.has(key)) continue;
      seen.add(key);

      results.push({
        type: 'db_query',
        label: key,
        schema: schema || 'public',
        table,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Upsert table ownership
// ---------------------------------------------------------------------------

async function upsertTableOwnership(client, repoName, filePath, tableRefs) {
  for (const ref of tableRefs) {
    await client.query(
      `INSERT INTO cortex.table_ownership
         (table_name, schema_name, repo_name, detected_in, access_type)
       VALUES ($1, $2, $3, ARRAY[$4::text], 'readwrite')
       ON CONFLICT (table_name, schema_name, repo_name)
       DO UPDATE SET
         detected_in = array_append(
           array_remove(cortex.table_ownership.detected_in, $4::text),
           $4::text
         ),
         updated_at = NOW()`,
      [ref.table, ref.schema, repoName, filePath]
    );
  }
}

// ---------------------------------------------------------------------------
// Process one chunk
// ---------------------------------------------------------------------------

async function processChunk(client, chunk, repoName) {
  const { id, content, language, file_path: filePath } = chunk;
  const edgesCreated = [];

  // 1. Imports
  const imports = extractImports(content, language);
  for (const imp of imports) {
    edgesCreated.push({ sourceId: id, targetId: null, type: 'import', label: imp.label });
  }

  // 2. Routes
  const routes = extractRoutes(content);
  for (const route of routes) {
    edgesCreated.push({ sourceId: id, targetId: null, type: 'route', label: route.label });
  }

  // 3. SQL tables
  const tables = extractSqlTables(content);
  for (const tbl of tables) {
    edgesCreated.push({ sourceId: id, targetId: null, type: 'db_query', label: tbl.label });
  }

  // Batch insert edges (delete old ones first for this chunk)
  if (edgesCreated.length > 0) {
    await client.query(
      `DELETE FROM cortex.graph_edges WHERE source_chunk_id = $1`,
      [id]
    );

    for (const edge of edgesCreated) {
      await client.query(
        `INSERT INTO cortex.graph_edges (repo_name, source_chunk_id, target_chunk_id, edge_type, label)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [repoName, edge.sourceId, edge.targetId, edge.type, edge.label]
      );
    }

    // Update table ownership
    const tableRefs = tables.map(t => ({ table: t.label.split('.')[1] || t.label, schema: t.label.split('.')[0] }));
    if (tableRefs.length > 0) {
      await upsertTableOwnership(client, repoName, filePath, tableRefs);
    }
  }

  return edgesCreated.length;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the knowledge graph for a repo.
 * Reads all code_chunks and writes edges to graph_edges.
 *
 * @param {object} repoConfig - Merged repo config
 * @returns {Promise<{chunks: number, edges: number, errors: number}>}
 */
export async function buildGraph(repoConfig) {
  const { name: repoName } = repoConfig;

  console.log(`[cortex:graph] Building graph for ${repoName}...`);
  const start = Date.now();

  const chunks = await queryRows(
    `SELECT id, content, language, file_path
     FROM cortex.code_chunks
     WHERE repo_name = $1`,
    [repoName]
  );

  console.log(`[cortex:graph] Processing ${chunks.length} chunks...`);

  let totalEdges = 0;
  let errors = 0;
  const BATCH = 100;

  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);

    try {
      await withTransaction(async (client) => {
        for (const chunk of batch) {
          try {
            const n = await processChunk(client, chunk, repoName);
            totalEdges += n;
          } catch (err) {
            errors++;
            await logError({ repoName, operation: 'graph', message: err.message });
          }
        }
      });
    } catch (err) {
      errors++;
      console.error(`[cortex:graph] Batch error: ${err.message}`);
    }

    if ((i + BATCH) % 500 === 0) {
      console.log(`[cortex:graph] ${repoName}: ${i + BATCH}/${chunks.length} chunks...`);
    }
  }

  const duration = Date.now() - start;
  console.log(
    `[cortex:graph] ${repoName}: done in ${duration}ms — ` +
    `${chunks.length} chunks, ${totalEdges} edges, ${errors} errors`
  );

  return { chunks: chunks.length, edges: totalEdges, errors };
}

/**
 * Get graph edges for a repo (for API response).
 */
export async function getGraphEdges(repoName, options = {}) {
  const { edgeType, limit = 500 } = options;

  let sql = `
    SELECT ge.id, ge.edge_type, ge.label,
           sc.chunk_name AS source_name, sc.relative_path AS source_path,
           sc.chunk_type AS source_type,
           tc.chunk_name AS target_name, tc.relative_path AS target_path
    FROM cortex.graph_edges ge
    JOIN cortex.code_chunks sc ON sc.id = ge.source_chunk_id
    LEFT JOIN cortex.code_chunks tc ON tc.id = ge.target_chunk_id
    WHERE ge.repo_name = $1
  `;
  const params = [repoName];

  if (edgeType) {
    params.push(edgeType);
    sql += ` AND ge.edge_type = $${params.length}`;
  }

  sql += ` ORDER BY ge.id LIMIT $${params.length + 1}`;
  params.push(limit);

  return queryRows(sql, params);
}
