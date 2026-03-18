/**
 * src/scan/index.js
 * Orchestrates file-walker + chunker → upsert to cortex.code_chunks.
 * Hashes each chunk (MD5), skips unchanged chunks, deletes stale ones.
 * Logs to cortex.scan_log.
 */

import { createHash } from 'crypto';
import { walkRepo, walkFile } from './file-walker.js';
import { chunkFile, estimateTokens } from './chunker.js';
import { query, queryRows, withTransaction, logError } from '../db/connection.js';
import { getConfig } from '../config.js';

// ---------------------------------------------------------------------------
// Hash
// ---------------------------------------------------------------------------

function md5(text) {
  return createHash('md5').update(text, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Ollama embedding (optional)
// ---------------------------------------------------------------------------

async function getEmbedding(text, ollamaConfig) {
  if (!ollamaConfig?.enabled) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ollamaConfig.timeoutMs || 30000);

    const res = await fetch(`${ollamaConfig.host}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: ollamaConfig.model, prompt: text }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      console.warn(`[cortex:scan] Ollama embedding failed: HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    return data.embedding || null;
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.warn(`[cortex:scan] Ollama embedding error: ${err.message}`);
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Scan log helpers
// ---------------------------------------------------------------------------

async function startScanLog(repoName, scanType = 'full') {
  const res = await query(
    `INSERT INTO cortex.scan_log (repo_name, scan_type, status)
     VALUES ($1, $2, 'running') RETURNING id`,
    [repoName, scanType]
  );
  return res.rows[0].id;
}

async function completeScanLog(logId, stats) {
  await query(
    `UPDATE cortex.scan_log
     SET status = $1, files_scanned = $2, chunks_upserted = $3,
         chunks_deleted = $4, errors_count = $5,
         duration_ms = $6, completed_at = NOW()
     WHERE id = $7`,
    [
      stats.errors > 0 && stats.upserted === 0 ? 'failed' : 'completed',
      stats.files, stats.upserted, stats.deleted, stats.errors,
      stats.durationMs, logId,
    ]
  );
}

// ---------------------------------------------------------------------------
// Upsert a single chunk
// ---------------------------------------------------------------------------

async function upsertChunk(client, repoName, fileDesc, chunk, embedding) {
  const embeddingValue = embedding
    ? `[${embedding.join(',')}]`
    : null;

  await client.query(
    `INSERT INTO cortex.code_chunks
       (repo_name, file_path, relative_path, chunk_name, chunk_type,
        language, content, content_hash, start_line, end_line,
        file_size, file_mtime, embedding, token_estimate, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
             $13::vector, $14, NOW())
     ON CONFLICT (repo_name, relative_path, chunk_name, chunk_type)
     DO UPDATE SET
       content       = EXCLUDED.content,
       content_hash  = EXCLUDED.content_hash,
       start_line    = EXCLUDED.start_line,
       end_line      = EXCLUDED.end_line,
       file_size     = EXCLUDED.file_size,
       file_mtime    = EXCLUDED.file_mtime,
       embedding     = COALESCE(EXCLUDED.embedding, cortex.code_chunks.embedding),
       token_estimate = EXCLUDED.token_estimate,
       updated_at    = NOW()
     WHERE cortex.code_chunks.content_hash != EXCLUDED.content_hash
        OR cortex.code_chunks.embedding IS NULL`,
    [
      repoName,
      fileDesc.path,
      fileDesc.relativePath,
      chunk.name,
      chunk.type,
      chunk.language,
      chunk.content,
      md5(chunk.content),
      chunk.startLine,
      chunk.endLine,
      fileDesc.size,
      fileDesc.mtime,
      embeddingValue,
      estimateTokens(chunk.content),
    ]
  );
}

// ---------------------------------------------------------------------------
// Delete stale chunks (files that no longer exist in the current scan)
// ---------------------------------------------------------------------------

async function deleteStaleChunks(repoName, currentRelativePaths) {
  if (currentRelativePaths.length === 0) return 0;

  const res = await query(
    `DELETE FROM cortex.code_chunks
     WHERE repo_name = $1
       AND relative_path != ALL($2::text[])
     RETURNING id`,
    [repoName, currentRelativePaths]
  );

  return res.rowCount || 0;
}

// ---------------------------------------------------------------------------
// Process a single file
// ---------------------------------------------------------------------------

async function processFile(fileDesc, repoConfig, ollamaConfig) {
  const { name: repoName, scan: scanConfig } = repoConfig;
  const chunks = chunkFile(fileDesc.path, fileDesc.language, scanConfig);

  if (chunks.length === 0) return { upserted: 0, errors: 0 };

  let upserted = 0;
  let errors = 0;

  // Check existing hashes to skip unchanged chunks
  const existingRows = await queryRows(
    `SELECT chunk_name, chunk_type, content_hash, embedding
     FROM cortex.code_chunks
     WHERE repo_name = $1 AND relative_path = $2`,
    [repoName, fileDesc.relativePath]
  );

  const existingMap = new Map(
    existingRows.map(r => [`${r.chunk_name}::${r.chunk_type}`, r])
  );

  await withTransaction(async (client) => {
    for (const chunk of chunks) {
      try {
        const key = `${chunk.name}::${chunk.type}`;
        const existing = existingMap.get(key);
        const hash = md5(chunk.content);

        // Skip if unchanged and already embedded
        if (existing && existing.content_hash === hash && existing.embedding) {
          continue;
        }

        // Get embedding if needed
        let embedding = null;
        if (scanConfig.embedChunks !== false && ollamaConfig?.enabled) {
          if (!existing || existing.content_hash !== hash || !existing.embedding) {
            embedding = await getEmbedding(chunk.content, ollamaConfig);
          }
        }

        await upsertChunk(client, repoName, fileDesc, chunk, embedding);
        upserted++;
      } catch (err) {
        errors++;
        await logError({
          repoName,
          operation: 'scan',
          filePath: fileDesc.path,
          message: err.message,
          stack: err.stack,
        });
      }
    }
  });

  return { upserted, errors };
}

// ---------------------------------------------------------------------------
// Main: full scan
// ---------------------------------------------------------------------------

/**
 * Run a full scan of a repository.
 * Walks all files, chunks them, upserts to DB, deletes stale chunks.
 *
 * @param {object} repoConfig - Merged repo config
 * @returns {Promise<{files, upserted, deleted, errors, durationMs}>}
 */
export async function runScan(repoConfig) {
  const cfg = getConfig();
  const { name: repoName } = repoConfig;
  const ollamaConfig = cfg.ollama;

  console.log(`[cortex:scan] Starting full scan: ${repoName}`);
  const startedAt = Date.now();
  const logId = await startScanLog(repoName, 'full');

  const stats = { files: 0, upserted: 0, deleted: 0, errors: 0, durationMs: 0 };

  try {
    const files = await walkRepo(repoConfig);
    stats.files = files.length;

    // Process files with concurrency limit
    const concurrency = repoConfig.scan?.concurrency || 4;
    const currentPaths = files.map(f => f.relativePath);

    // Process in batches
    for (let i = 0; i < files.length; i += concurrency) {
      const batch = files.slice(i, i + concurrency);
      const results = await Promise.allSettled(
        batch.map(f => processFile(f, repoConfig, ollamaConfig))
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          stats.upserted += result.value.upserted;
          stats.errors += result.value.errors;
        } else {
          stats.errors++;
          console.error(`[cortex:scan] File batch error: ${result.reason?.message}`);
        }
      }

      if (i % (concurrency * 10) === 0 && i > 0) {
        console.log(`[cortex:scan] ${repoName}: ${i}/${files.length} files...`);
      }
    }

    // Delete chunks for files no longer in the repo
    stats.deleted = await deleteStaleChunks(repoName, currentPaths);

  } catch (err) {
    stats.errors++;
    await logError({ repoName, operation: 'scan', message: err.message, stack: err.stack });
    console.error(`[cortex:scan] Scan failed for ${repoName}: ${err.message}`);
  }

  stats.durationMs = Date.now() - startedAt;
  await completeScanLog(logId, stats);

  console.log(
    `[cortex:scan] ${repoName}: done in ${stats.durationMs}ms — ` +
    `${stats.files} files, ${stats.upserted} upserted, ${stats.deleted} deleted, ${stats.errors} errors`
  );

  return stats;
}

// ---------------------------------------------------------------------------
// Incremental: scan a single file (for chokidar)
// ---------------------------------------------------------------------------

/**
 * Scan a single file incrementally.
 *
 * @param {object} repoConfig - Merged repo config
 * @param {string} absolutePath - Absolute path to changed file
 * @returns {Promise<{upserted, errors}>}
 */
export async function scanFile(repoConfig, absolutePath) {
  const cfg = getConfig();
  const ollamaConfig = cfg.ollama;

  const { walkFile } = await import('./file-walker.js');
  const fileDesc = await walkFile(repoConfig, absolutePath);

  if (!fileDesc) {
    // File deleted — remove its chunks
    const rel = absolutePath
      .replace(repoConfig.path, '')
      .replace(/\\/g, '/')
      .replace(/^\//, '');

    const res = await query(
      `DELETE FROM cortex.code_chunks WHERE repo_name = $1 AND relative_path = $2`,
      [repoConfig.name, rel]
    );
    console.log(`[cortex:scan] Deleted chunks for removed file: ${rel}`);
    return { upserted: 0, errors: 0, deleted: res.rowCount || 0 };
  }

  console.log(`[cortex:scan] Incremental: ${fileDesc.relativePath}`);
  return processFile(fileDesc, repoConfig, ollamaConfig);
}
