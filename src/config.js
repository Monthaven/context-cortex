/**
 * src/config.js
 * Loads and validates cortex.config.json from the project root.
 * Falls back to environment variables if no config file is present.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadEnvFallback() {
  return {
    database: {
      host: process.env.CORTEX_DB_HOST || 'localhost',
      port: parseInt(process.env.CORTEX_DB_PORT || '5432', 10),
      database: process.env.CORTEX_DB_NAME || 'postgres',
      user: process.env.CORTEX_DB_USER || 'postgres',
      password: process.env.CORTEX_DB_PASSWORD || '',
      ssl: process.env.CORTEX_DB_SSL === 'true',
      max: parseInt(process.env.CORTEX_DB_POOL_MAX || '10', 10),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    },
    ollama: {
      enabled: process.env.CORTEX_OLLAMA_ENABLED !== 'false',
      host: process.env.CORTEX_OLLAMA_HOST || 'http://localhost:11434',
      model: process.env.CORTEX_OLLAMA_MODEL || 'nomic-embed-text',
      dimensions: parseInt(process.env.CORTEX_OLLAMA_DIMS || '768', 10),
      timeoutMs: 30000,
    },
    scan: defaultScanConfig(),
    health: { schedule: '*/15 * * * *', timeoutMs: 5000, retries: 2 },
    context: defaultContextConfig(),
    server: {
      port: parseInt(process.env.CORTEX_PORT || '3131', 10),
      host: process.env.CORTEX_HOST || 'localhost',
      apiKey: process.env.CORTEX_API_KEY || '',
    },
    repos: [],
  };
}

function defaultScanConfig() {
  return {
    concurrency: 4,
    chunkSizeLines: 80,
    chunkOverlapLines: 5,
    embedChunks: true,
    hashAlgorithm: 'md5',
    ignorePatterns: [
      'node_modules/**', '.git/**', 'dist/**', 'build/**',
      '.next/**', 'coverage/**', '*.min.js', '*.min.css',
      '*.map', '*.lock', '*.log', 'vendor/**',
    ],
    includeExtensions: [
      '.js', '.mjs', '.cjs', '.ts', '.tsx', '.py',
      '.go', '.rb', '.java', '.rs', '.sql', '.md',
      '.json', '.yaml', '.yml', '.toml', '.sh', '.bash',
    ],
  };
}

function defaultContextConfig() {
  return {
    outputFileName: 'CLAUDE.md',
    maxChunksInSummary: 20,
    maxRoutesListed: 50,
    maxTablesListed: 30,
    includeGraphSummary: true,
    includeHealthSummary: true,
  };
}

function stripCommentKeys(obj) {
  if (Array.isArray(obj)) return obj.map(stripCommentKeys);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('_')) continue;
      out[k] = stripCommentKeys(v);
    }
    return out;
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validate(cfg) {
  const errors = [];

  if (!cfg.database) {
    errors.push('Missing required field: database');
  } else {
    if (!cfg.database.host) errors.push('database.host is required');
    if (!cfg.database.database) errors.push('database.database is required');
    if (!cfg.database.user) errors.push('database.user is required');
  }

  if (!cfg.repos || !Array.isArray(cfg.repos)) {
    errors.push('Missing required field: repos (must be an array)');
  } else {
    cfg.repos.forEach((repo, i) => {
      if (!repo.name) errors.push(`repos[${i}].name is required`);
      if (!repo.path) errors.push(`repos[${i}].path is required`);
    });
    // Check for duplicate repo names
    const names = cfg.repos.map(r => r.name).filter(Boolean);
    const dups = names.filter((n, i) => names.indexOf(n) !== i);
    if (dups.length) errors.push(`Duplicate repo names: ${dups.join(', ')}`);
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Merge: global defaults + per-repo overrides
// ---------------------------------------------------------------------------

function mergeRepoConfig(globalCfg, repo) {
  const globalScan = { ...defaultScanConfig(), ...globalCfg.scan };
  const repoScan = { ...globalScan, ...(repo.scan || {}) };

  // Merge ignore patterns
  if (repo.scan?.additionalIgnore) {
    repoScan.ignorePatterns = [
      ...globalScan.ignorePatterns,
      ...repo.scan.additionalIgnore,
    ];
  }

  return {
    ...repo,
    scan: repoScan,
    services: repo.services || {},
    context: {
      ...defaultContextConfig(),
      ...globalCfg.context,
      ...(repo.context || {}),
    },
    axon: repo.axon || { enabled: false },
  };
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

function loadConfig() {
  const configPath = join(ROOT, 'cortex.config.json');

  if (!existsSync(configPath)) {
    console.warn('[cortex:config] cortex.config.json not found — using env vars / defaults');
    const cfg = loadEnvFallback();
    cfg._source = 'env';
    return cfg;
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new Error(`[cortex:config] Failed to parse cortex.config.json: ${err.message}`);
  }

  // Strip _comment / _readme keys
  const cfg = stripCommentKeys(raw);

  // Apply defaults
  cfg.scan = { ...defaultScanConfig(), ...cfg.scan };
  cfg.context = { ...defaultContextConfig(), ...cfg.context };
  cfg.health = { schedule: '*/15 * * * *', timeoutMs: 5000, retries: 2, ...cfg.health };
  cfg.server = { port: 3131, host: 'localhost', apiKey: '', ...cfg.server };
  cfg.ollama = {
    enabled: true,
    host: 'http://localhost:11434',
    model: 'nomic-embed-text',
    dimensions: 768,
    timeoutMs: 30000,
    ...cfg.ollama,
  };

  // Expand repo configs with merged settings
  cfg.repos = (cfg.repos || []).map(repo => mergeRepoConfig(cfg, repo));

  const errors = validate(cfg);
  if (errors.length) {
    throw new Error(`[cortex:config] Configuration errors:\n  - ${errors.join('\n  - ')}`);
  }

  cfg._source = 'file';
  cfg._path = configPath;

  return cfg;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _config = null;

export function getConfig() {
  if (!_config) _config = loadConfig();
  return _config;
}

export function getRepoConfig(name) {
  const cfg = getConfig();
  const repo = cfg.repos.find(r => r.name === name);
  if (!repo) throw new Error(`[cortex:config] Repo not found: ${name}`);
  return repo;
}

export default getConfig;
