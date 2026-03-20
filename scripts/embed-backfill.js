#!/usr/bin/env node
/**
 * scripts/embed-backfill.js
 * Generates embeddings for all cortex.code_chunks where embedding IS NULL.
 * Uses Ollama nomic-embed-text (768 dims).
 *
 * Usage: node scripts/embed-backfill.js
 *
 * Configuration:
 *   - Reads DB config from cortex.config.json (via src/config.js)
 *   - Ollama URL from config or OLLAMA_URL env var
 *   - Falls back to docker exec if direct Ollama TCP fails (Windows workaround)
 */

import 'dotenv/config';
import { execFileSync } from 'child_process';
import { getConfig } from '../src/config.js';
import { getPool, queryOne, queryRows, query, closePool } from '../src/db/connection.js';

const cfg = getConfig();
const OLLAMA_URL = cfg.ollama?.host || process.env.OLLAMA_URL || 'http://localhost:11434';
const EMBED_MODEL = cfg.ollama?.model || 'nomic-embed-text';
const DIMENSIONS = cfg.ollama?.dimensions || 768;
// Docker container name for fallback (Windows Docker Desktop TCP workaround)
const OLLAMA_CONTAINER = process.env.OLLAMA_CONTAINER || 'sona_ollama';
const BATCH = 5;
const DELAY_MS = 100;

// ── Embedding helpers ────────────────────────────────────────────────────────

async function getEmbeddingDirect(text) {
  const truncated = text.slice(0, 4000);
  const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: truncated }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.embedding;
}

function getEmbeddingViaDocker(text) {
  const truncated = text.slice(0, 4000);
  const body = JSON.stringify({ model: EMBED_MODEL, prompt: truncated });
  const result = execFileSync('docker', [
    'exec', OLLAMA_CONTAINER, 'curl', '-s',
    '-X', 'POST',
    '-H', 'Content-Type: application/json',
    '-d', body,
    'http://localhost:11434/api/embeddings'
  ], { encoding: 'utf8', timeout: 60000, maxBuffer: 5 * 1024 * 1024 });
  const data = JSON.parse(result.trim());
  if (!data.embedding) throw new Error(`Ollama returned no embedding: ${result.slice(0, 200)}`);
  return data.embedding;
}

let _useDockerOllama = null;
async function getEmbedding(text) {
  if (_useDockerOllama === true) return getEmbeddingViaDocker(text);
  if (_useDockerOllama === false) return getEmbeddingDirect(text);
  // Auto-detect
  try {
    await getEmbeddingDirect('test');
    _useDockerOllama = false;
    return getEmbeddingDirect(text);
  } catch {
    _useDockerOllama = true;
    console.log('[embed] Using docker exec transport for Ollama (direct TCP failed)');
    return getEmbeddingViaDocker(text);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Check Ollama
  console.log(`[embed] Checking Ollama at ${OLLAMA_URL}...`);
  try {
    let data;
    try {
      const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5000) });
      data = await r.json();
    } catch {
      console.log('[embed] Direct TCP failed, trying docker exec...');
      const result = execFileSync('docker', [
        'exec', OLLAMA_CONTAINER, 'curl', '-s', 'http://localhost:11434/api/tags'
      ], { encoding: 'utf8', timeout: 10000 });
      data = JSON.parse(result.trim());
    }
    const models = data.models?.map(m => m.name) || [];
    const hasModel = models.some(m => m.includes(EMBED_MODEL.replace(':latest', '')));
    if (!hasModel) {
      console.error(`[embed] ${EMBED_MODEL} not found in Ollama. Available: ${models.join(', ')}`);
      console.error(`[embed] Run: curl ${OLLAMA_URL}/api/pull -d '{"name":"${EMBED_MODEL}"}'`);
      process.exit(1);
    }
    console.log(`[embed] Ollama OK. Model: ${EMBED_MODEL}`);
  } catch (e) {
    console.error('[embed] Cannot reach Ollama:', e.message);
    process.exit(1);
  }

  // Count NULL embeddings
  const countRow = await queryOne('SELECT COUNT(*) as cnt FROM cortex.code_chunks WHERE embedding IS NULL');
  const total = parseInt(countRow?.cnt || 0);
  console.log(`[embed] ${total} chunks need embedding`);
  if (total === 0) {
    console.log('[embed] All done!');
    await closePool();
    return;
  }

  let done = 0, errors = 0;
  const startTime = Date.now();

  // Process in batches
  while (true) {
    const chunks = await queryRows(
      `SELECT id, content FROM cortex.code_chunks
       WHERE embedding IS NULL
       ORDER BY id LIMIT $1`,
      [BATCH]
    );
    if (chunks.length === 0) break;

    for (const chunk of chunks) {
      try {
        const embedding = await getEmbedding(chunk.content || '');
        const vecStr = `[${embedding.join(',')}]`;
        await query(
          `UPDATE cortex.code_chunks SET embedding = $1::vector(${DIMENSIONS}), updated_at = NOW() WHERE id = $2`,
          [vecStr, chunk.id]
        );
        done++;
      } catch (err) {
        errors++;
        if (errors < 5) console.warn(`[embed] Error on chunk ${chunk.id}: ${err.message}`);
        // Mark updated_at to avoid infinite loop on bad chunks
        await query('UPDATE cortex.code_chunks SET updated_at = NOW() WHERE id = $1', [chunk.id]).catch(() => {});
      }
    }

    if (done % 100 === 0 || done + errors >= total) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const pct = ((done + errors) / total * 100).toFixed(1);
      const rate = done / (elapsed || 1);
      const remaining = Math.round((total - done - errors) / (rate || 1));
      console.log(`[embed] ${done}/${total} embedded (${pct}%) | ${errors} errors | ~${remaining}s remaining`);
    }

    if (DELAY_MS > 0) await new Promise(r => setTimeout(r, DELAY_MS));
  }

  // Build vector index (IVFFlat needs enough rows to train)
  console.log('[embed] Building IVFFlat vector index...');
  try {
    await query(
      `CREATE INDEX IF NOT EXISTS code_chunks_embedding_backfill_idx
       ON cortex.code_chunks USING ivfflat (embedding vector_cosine_ops)
       WITH (lists = 50)`
    );
    console.log('[embed] Vector index created.');
  } catch (e) {
    console.warn('[embed] Index creation failed (needs enough rows to train):', e.message);
  }

  console.log(`\n[embed] Complete: ${done} embedded, ${errors} errors`);
  await closePool();
}

main().catch(err => { console.error(err); process.exit(1); });
