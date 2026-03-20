#!/usr/bin/env node

/**
 * scripts/init.js — Interactive Config Generator
 *
 * Generates cortex.config.json with sensible defaults, auto-detects
 * repo language/entry points, tests DB and Ollama connectivity.
 *
 * Usage:
 *   node scripts/init.js
 *   npm run init
 */

import { createInterface } from 'readline';
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { resolve, dirname, join, basename, extname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CONFIG_PATH = join(ROOT, 'cortex.config.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ask(rl, question, defaultValue) {
  const prompt = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

function generateApiKey() {
  return randomBytes(16).toString('hex');
}

/**
 * Scan a directory (shallow + one level of src/) to detect language from file extensions.
 */
function detectLanguage(repoPath) {
  const counts = {};
  const extToLang = {
    '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
    '.ts': 'typescript', '.tsx': 'typescript',
    '.py': 'python',
    '.go': 'go',
    '.rs': 'rust',
    '.rb': 'ruby',
    '.java': 'java',
    '.cs': 'csharp',
    '.php': 'php',
    '.swift': 'swift',
    '.kt': 'kotlin',
    '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp',
    '.c': 'c',
  };

  const dirsToScan = [repoPath];
  const srcDir = join(repoPath, 'src');
  if (existsSync(srcDir) && statSync(srcDir).isDirectory()) {
    dirsToScan.push(srcDir);
  }
  const appDir = join(repoPath, 'app');
  if (existsSync(appDir) && statSync(appDir).isDirectory()) {
    dirsToScan.push(appDir);
  }
  const libDir = join(repoPath, 'lib');
  if (existsSync(libDir) && statSync(libDir).isDirectory()) {
    dirsToScan.push(libDir);
  }

  for (const dir of dirsToScan) {
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const ext = extname(entry).toLowerCase();
        const lang = extToLang[ext];
        if (lang) {
          counts[lang] = (counts[lang] || 0) + 1;
        }
      }
    } catch {
      // skip unreadable dirs
    }
  }

  if (Object.keys(counts).length === 0) return null;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * Look for common entry point files.
 */
function detectEntryPoints(repoPath) {
  const candidates = [
    'src/index.js', 'src/index.ts', 'src/index.mjs',
    'src/server.js', 'src/server.ts',
    'src/app.js', 'src/app.ts',
    'src/main.js', 'src/main.ts',
    'src/core/server.js', 'src/core/index.js',
    'main.py', 'app.py', 'manage.py',
    'index.js', 'index.ts',
    'server.js', 'server.ts',
    'app/main.py',
  ];

  return candidates.filter((c) => existsSync(join(repoPath, c)));
}

/**
 * Try to read package name from package.json or pyproject.toml.
 */
function detectPackageName(repoPath) {
  const pkgPath = join(repoPath, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      return pkg.name || null;
    } catch {
      return null;
    }
  }

  const pyprojectPath = join(repoPath, 'pyproject.toml');
  if (existsSync(pyprojectPath)) {
    try {
      const content = readFileSync(pyprojectPath, 'utf-8');
      const match = content.match(/^name\s*=\s*"([^"]+)"/m);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Test PostgreSQL connectivity.
 */
async function testDatabase(dbConfig) {
  try {
    const pg = await import('pg');
    const Pool = pg.default?.Pool || pg.Pool;
    const pool = new Pool({
      host: dbConfig.host,
      port: dbConfig.port,
      database: dbConfig.database,
      user: dbConfig.user,
      password: dbConfig.password,
      connectionTimeoutMillis: 5000,
    });
    const res = await pool.query('SELECT 1 AS ok');
    await pool.end();
    return res.rows[0]?.ok === 1;
  } catch (err) {
    return false;
  }
}

/**
 * Test Ollama connectivity.
 */
async function testOllama(ollamaUrl) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${ollamaUrl}/api/tags`, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('');
  console.log('  Context Cortex — Interactive Setup');
  console.log('  ==================================');
  console.log('');

  // Check if config already exists
  if (existsSync(CONFIG_PATH)) {
    console.log(`  cortex.config.json already exists at: ${CONFIG_PATH}`);
    console.log('  Delete it first if you want to regenerate, or edit it directly.');
    console.log('');
    console.log('  To proceed with setup using existing config:  npm run setup');
    process.exit(0);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    // --- Repo detection ---
    const cwd = process.cwd();
    console.log(`  Detected working directory: ${cwd}`);
    console.log('');

    const repoPath = await ask(rl, 'Repository path to scan', cwd);
    const resolvedRepoPath = resolve(repoPath);

    if (!existsSync(resolvedRepoPath)) {
      console.error(`  Error: path does not exist: ${resolvedRepoPath}`);
      process.exit(1);
    }

    // Auto-detect repo info
    const detectedLang = detectLanguage(resolvedRepoPath);
    const detectedName = detectPackageName(resolvedRepoPath) || basename(resolvedRepoPath);
    const detectedEntries = detectEntryPoints(resolvedRepoPath);

    console.log('');
    console.log('  Auto-detected:');
    if (detectedLang) console.log(`    Language:     ${detectedLang}`);
    if (detectedName) console.log(`    Name:         ${detectedName}`);
    if (detectedEntries.length > 0) console.log(`    Entry points: ${detectedEntries.join(', ')}`);
    console.log('');

    const repoName = await ask(rl, 'Repo name', detectedName);
    const repoDesc = await ask(rl, 'Repo description', '');
    const language = await ask(rl, 'Language', detectedLang || 'javascript');

    // --- Database ---
    console.log('');
    console.log('  Database Configuration');
    console.log('  ----------------------');
    const dbHost = await ask(rl, 'Database host', 'localhost');
    const dbPort = await ask(rl, 'Database port', '5432');
    const dbName = await ask(rl, 'Database name', 'postgres');
    const dbUser = await ask(rl, 'Database user', 'postgres');
    const dbPassword = await ask(rl, 'Database password', '');

    // --- Ollama ---
    console.log('');
    console.log('  Ollama Configuration');
    console.log('  --------------------');
    const ollamaUrl = await ask(rl, 'Ollama URL', 'http://localhost:11434');

    // --- Server ---
    console.log('');
    console.log('  Server Configuration');
    console.log('  --------------------');
    const serverPort = await ask(rl, 'Server port', '3131');
    const apiKey = generateApiKey();
    console.log(`  Generated API key: ${apiKey}`);

    rl.close();

    // --- Build config ---
    const config = {
      database: {
        host: dbHost,
        port: parseInt(dbPort, 10),
        database: dbName,
        user: dbUser,
        password: dbPassword,
        ssl: false,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      },
      ollama: {
        enabled: true,
        host: ollamaUrl,
        model: 'nomic-embed-text',
        dimensions: 768,
        timeoutMs: 30000,
      },
      scan: {
        concurrency: 4,
        chunkSizeLines: 80,
        chunkOverlapLines: 5,
        embedChunks: true,
        ignorePatterns: [
          'node_modules/**', '.git/**', 'dist/**', 'build/**',
          '.next/**', 'coverage/**', '*.min.js', '*.min.css',
          '*.map', '*.lock', '*.log', 'vendor/**',
        ],
      },
      health: {
        schedule: '*/15 * * * *',
        timeoutMs: 5000,
        retries: 2,
      },
      context: {
        outputFileName: 'CLAUDE.md',
        maxChunksInSummary: 20,
        maxRoutesListed: 50,
        maxTablesListed: 30,
        includeGraphSummary: true,
        includeHealthSummary: true,
      },
      server: {
        port: parseInt(serverPort, 10),
        host: 'localhost',
        apiKey,
      },
      repos: [
        {
          name: repoName,
          path: resolvedRepoPath.replace(/\\/g, '/'),
          description: repoDesc || undefined,
          language,
          ...(detectedEntries.length > 0 ? { entryPoints: detectedEntries } : {}),
        },
      ],
    };

    // Remove undefined description
    if (!config.repos[0].description) delete config.repos[0].description;

    // --- Write config ---
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    console.log('');
    console.log(`  Config written to: ${CONFIG_PATH}`);

    // --- Test connectivity ---
    console.log('');
    console.log('  Testing connectivity...');

    const dbOk = await testDatabase(config.database);
    console.log(`    PostgreSQL: ${dbOk ? 'connected' : 'FAILED — check credentials and ensure PostgreSQL is running'}`);

    const ollamaOk = await testOllama(config.ollama.host);
    console.log(`    Ollama:     ${ollamaOk ? 'connected' : 'FAILED — Ollama not reachable (embeddings will be skipped)'}`);

    if (!ollamaOk) {
      config.ollama.enabled = false;
      writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
      console.log('    -> Disabled Ollama in config. Re-enable when available.');
    }

    // --- Summary ---
    console.log('');
    console.log('  === Configuration Summary ===');
    console.log(`  Config file:   ${CONFIG_PATH}`);
    console.log(`  Repo:          ${repoName} (${language})`);
    console.log(`  Repo path:     ${resolvedRepoPath}`);
    console.log(`  Database:      ${dbUser}@${dbHost}:${dbPort}/${dbName}`);
    console.log(`  Ollama:        ${config.ollama.enabled ? ollamaUrl : 'disabled'}`);
    console.log(`  Server port:   ${serverPort}`);
    console.log(`  API key:       ${apiKey}`);
    if (detectedEntries.length > 0) {
      console.log(`  Entry points:  ${detectedEntries.join(', ')}`);
    }

    console.log('');
    console.log('  Next steps:');
    console.log('    1. Run first-time setup:        npm run setup');
    console.log('    2. Start the server:            npm start');
    console.log('    3. Connect to Claude Code:      npm run add-to-claude');
    console.log('');
  } catch (err) {
    rl.close();
    console.error(`  Fatal error: ${err.message}`);
    process.exit(1);
  }
}

main();
