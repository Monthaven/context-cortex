#!/usr/bin/env node
/**
 * scripts/backfill-metadata.js
 * Extracts chunk_type, chunk_name, and metadata (db_tables, env_vars, todos,
 * imports, external_calls, complexity, is_stub) from existing code_chunks content
 * and stores them in the `meta` JSONB column.
 *
 * Context-cortex stores enrichment data in the `meta` JSONB column rather than
 * dedicated columns (unlike sona-cortex which has separate array columns).
 *
 * Usage: node scripts/backfill-metadata.js
 */

import 'dotenv/config';
import { getPool, queryRows, query, closePool } from '../src/db/connection.js';

const BATCH = 200;

// ── Extractors ───────────────────────────────────────────────────────────────

function extractChunkType(content) {
  if (/(?:app|router)\s*\.\s*(?:get|post|put|patch|delete|all)\s*\(/.test(content)) return 'route';
  if (/\bclass\s+\w+/.test(content)) return 'class';
  if (/\bcron\.schedule\s*\(|createGuardedJob\s*\(|setInterval\s*\(/.test(content)) return 'cron';
  if (/export\s+(?:default\s+)?(?:async\s+)?function\s+\w+|module\.exports\s*=|exports\.\w+\s*=/.test(content)) return 'function';
  if (/def\s+\w+\s*\(/.test(content)) return 'function'; // Python
  if (/^(?:import|const|let|var)\s+/m.test(content) && !/\{/.test(content.slice(0, 50))) return 'module';
  return 'module';
}

function extractChunkName(content, chunkType) {
  if (chunkType === 'route') {
    const m = content.match(/(?:app|router)\s*\.\s*(get|post|put|patch|delete|all)\s*\(\s*['"`]([^'"`]+)/i);
    if (m) return `${m[1].toUpperCase()} ${m[2]}`;
  }
  if (chunkType === 'class') {
    const m = content.match(/class\s+(\w+)/);
    if (m) return m[1];
  }
  if (chunkType === 'function') {
    // JS/TS
    const m = content.match(/(?:export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(?|exports\.(\w+))/);
    if (m) return m[1] || m[2] || m[3];
    // Python
    const py = content.match(/def\s+(\w+)\s*\(/);
    if (py) return py[1];
  }
  if (chunkType === 'cron') {
    const m = content.match(/createGuardedJob\s*\(\s*['"][^'"]+['"]\s*,\s*['"]([^'"]+)['"]|cron\.schedule\s*\(\s*['"]([^'"]+)['"]/);
    if (m) return m[1] || m[2];
  }
  return null;
}

function extractDbTables(content) {
  const tables = new Set();
  const patterns = [
    /(?:FROM|JOIN|UPDATE|INTO|TABLE)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:\w+\.)?(\w{3,})/gi,
    /\.query\s*\(\s*['"`][^'"`]*(?:FROM|INTO|UPDATE)\s+(\w+)/gi,
  ];
  const stopwords = new Set([
    'the','and','or','not','null','true','false','where','set','on','as',
    'select','order','group','by','limit','offset','with','inner','left',
    'right','outer','case','when','then','else','end','in','is','like',
  ]);
  for (const pat of patterns) {
    pat.lastIndex = 0;
    let m;
    while ((m = pat.exec(content)) !== null) {
      const t = m[1].toLowerCase();
      if (!stopwords.has(t)) tables.add(t);
    }
  }
  return [...tables].slice(0, 20);
}

function extractExternalCalls(content) {
  const calls = new Set();
  const patterns = [
    /fetch\s*\(\s*['"`](https?:\/\/[^'"`\s]+)/g,
    /axios\s*\.\s*\w+\s*\(\s*['"`](https?:\/\/[^'"`\s]+)/g,
    /(?:got|request|superagent)\s*\(\s*['"`](https?:\/\/[^'"`\s]+)/g,
    /url\s*[:=]\s*['"`](https?:\/\/[^'"`\s]+)/gi,
    /baseURL\s*[:=]\s*['"`](https?:\/\/[^'"`\s]+)/gi,
  ];
  for (const pat of patterns) {
    pat.lastIndex = 0;
    let m;
    while ((m = pat.exec(content)) !== null) {
      try { calls.add(new URL(m[1]).origin); } catch {}
    }
  }
  return [...calls].slice(0, 10);
}

function extractEnvVars(content) {
  const vars = new Set();
  const pat = /process\.env\.(\w+)|process\.env\[['"](\w+)['"]\]|os\.environ(?:\.get)?\s*\(\s*['"](\w+)['"]/g;
  let m;
  while ((m = pat.exec(content)) !== null) {
    vars.add(m[1] || m[2] || m[3]);
  }
  return [...vars].slice(0, 20);
}

function extractTodos(content) {
  const todos = [];
  const lines = content.split('\n');
  for (const line of lines) {
    const m = line.match(/(?:\/\/|#|\/\*)\s*(TODO|FIXME|HACK|XXX|STUB)[:\s]+(.*)/i);
    if (m) todos.push(`${m[1]}: ${m[2].trim().slice(0, 120)}`);
  }
  return todos.slice(0, 10);
}

function extractImports(content) {
  const imports = new Set();
  const patterns = [
    /import\s+(?:[^'"]*\s+from\s+)?['"]([^'"]+)['"]/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /from\s+(\S+)\s+import/g, // Python
  ];
  for (const pat of patterns) {
    pat.lastIndex = 0;
    let m;
    while ((m = pat.exec(content)) !== null) {
      imports.add(m[1]);
    }
  }
  return [...imports].slice(0, 30);
}

function calcComplexity(content) {
  const keywords = /\b(if|else|switch|case|for|while|try|catch|finally|elif|except)\b|\?\s*:/g;
  return (content.match(keywords) || []).length;
}

function isStub(content) {
  const lines = content.split('\n').filter(l => l.trim() && !l.trim().startsWith('//') && !l.trim().startsWith('#') && !l.trim().startsWith('*'));
  return lines.length < 5;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[backfill] Loading chunks...');
  const chunks = await queryRows(
    'SELECT id, content, repo_name, chunk_type, chunk_name FROM cortex.code_chunks ORDER BY id'
  );
  console.log(`[backfill] Processing ${chunks.length} chunks...`);

  let processed = 0;

  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);

    for (const chunk of batch) {
      const c = chunk.content || '';
      const chunkType = extractChunkType(c);
      const chunkName = extractChunkName(c, chunkType);
      const dbTables = extractDbTables(c);
      const extCalls = extractExternalCalls(c);
      const envVars = extractEnvVars(c);
      const todos = extractTodos(c);
      const imports = extractImports(c);
      const complexity = calcComplexity(c);
      const stub = isStub(c);

      // Build meta JSONB with extracted fields
      const meta = {
        ...(chunk.meta || {}),
        db_tables: dbTables,
        external_calls: extCalls,
        env_vars: envVars,
        todos,
        imports,
        complexity,
        is_stub: stub,
      };

      await query(
        `UPDATE cortex.code_chunks
         SET chunk_type = COALESCE($1, chunk_type),
             chunk_name = COALESCE($2, chunk_name),
             meta = $3
         WHERE id = $4`,
        [chunkType, chunkName, JSON.stringify(meta), chunk.id]
      );
    }

    processed += batch.length;
    if (processed % 1000 === 0 || processed === chunks.length) {
      console.log(`[backfill] ${processed}/${chunks.length} chunks processed`);
    }
  }

  // Verify
  const stats = await queryRows(
    `SELECT chunk_type, COUNT(*) as cnt
     FROM cortex.code_chunks
     WHERE chunk_type IS NOT NULL
     GROUP BY chunk_type
     ORDER BY cnt DESC`
  );
  console.log('\n[backfill] Chunk types:');
  for (const row of stats) console.log(`  ${row.chunk_type}: ${row.cnt}`);

  const withTables = await queryRows(
    `SELECT COUNT(*) as cnt FROM cortex.code_chunks WHERE meta->>'db_tables' IS NOT NULL AND meta->'db_tables' != '[]'::jsonb`
  );
  console.log(`\n[backfill] Chunks with DB tables: ${withTables[0]?.cnt || 0}`);

  const withTodos = await queryRows(
    `SELECT COUNT(*) as cnt FROM cortex.code_chunks WHERE meta->>'todos' IS NOT NULL AND meta->'todos' != '[]'::jsonb`
  );
  console.log(`[backfill] Chunks with TODOs: ${withTodos[0]?.cnt || 0}`);

  console.log('\n[backfill] Done.');
  await closePool();
}

main().catch(err => { console.error(err); process.exit(1); });
