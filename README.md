# Context Cortex

Code intelligence layer for Claude Code. Scans your repos, builds a searchable code graph, tracks work history, and generates `CLAUDE.md` context files so every AI coding session starts informed.

## What It Does

Point Context Cortex at any codebase and it will:

- **Scan** source files and split them into semantic chunks (functions, classes, blocks)
- **Embed** each chunk with Ollama (`nomic-embed-text`, 768 dimensions)
- **Store** everything in PostgreSQL with pgvector for full-text and vector similarity search
- **Build a knowledge graph** of imports, API routes, and database table references
- **Generate `CLAUDE.md`** for each repo so Claude Code has instant context on every session
- **Monitor service health** (HTTP, TCP, Docker) and snapshot results over time
- **Watch files** with chokidar for live incremental updates as you code
- **Track work history** via `work_log` table — git commits, session logs, and status changes

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/context-cortex/context-cortex
cd context-cortex
npm install

# 2. Configure
cp cortex.config.example.json cortex.config.json
# Edit cortex.config.json — set database credentials and repo paths

# 3. First-time setup (creates schema, scans repos, builds graph, generates CLAUDE.md)
npm run setup

# 4. Start the server (file watcher + API + cron jobs)
npm start
```

The API is now available at `http://localhost:3131` (default port).

## Requirements

| Dependency | Version | Purpose |
|-----------|---------|---------|
| Node.js | 18+ | Runtime |
| PostgreSQL | 14+ with [pgvector](https://github.com/pgvector/pgvector) | Storage + vector search |
| [Ollama](https://ollama.ai) | Any | Embedding generation (`nomic-embed-text`) |

pgvector is strongly recommended but optional. Without it, embeddings are stored as TEXT and vector similarity search is unavailable (full-text search still works).

## Configuration

All configuration lives in `cortex.config.json` (gitignored). Copy the example file to get started:

```bash
cp cortex.config.example.json cortex.config.json
```

### Minimal Configuration

```json
{
  "database": {
    "host": "localhost",
    "port": 5432,
    "database": "postgres",
    "user": "postgres",
    "password": "your-password"
  },
  "repos": [
    {
      "name": "my-api",
      "path": "/absolute/path/to/my-api",
      "description": "My API server"
    }
  ]
}
```

### Full Configuration Reference

| Section | Required | Description |
|---------|----------|-------------|
| `database` | Yes | PostgreSQL connection (host, port, database, user, password, ssl, max, idleTimeoutMillis, connectionTimeoutMillis) |
| `repos` | Yes | Array of repositories to scan. Each needs `name` (unique) and `path` (absolute) |
| `ollama` | No | Embedding config: `enabled`, `host`, `model`, `dimensions`, `timeoutMs`. Defaults to localhost:11434 with nomic-embed-text |
| `scan` | No | Global scan defaults: `concurrency`, `chunkSizeLines`, `chunkOverlapLines`, `embedChunks`, `ignorePatterns`, `includeExtensions` |
| `health` | No | Health check settings: `schedule` (cron), `timeoutMs`, `retries` |
| `context` | No | CLAUDE.md generation: `outputFileName`, `maxChunksInSummary`, `maxRoutesListed`, `maxTablesListed`, `includeGraphSummary`, `includeHealthSummary` |
| `server` | No | HTTP API: `port` (default 3131), `host`, `apiKey` (optional auth) |

### Per-Repo Configuration

Each repo in the `repos` array supports:

```json
{
  "name": "my-api",
  "path": "/absolute/path/to/repo",
  "description": "Optional description",
  "language": "javascript",
  "scan": {
    "enabled": true,
    "schedule": "0 */6 * * *",
    "additionalIgnore": ["tmp/**", "uploads/**"]
  },
  "services": {
    "postgres": { "type": "tcp", "host": "localhost", "port": 5432 },
    "redis": { "type": "tcp", "host": "localhost", "port": 6379 },
    "api": { "type": "http", "url": "http://localhost:3000/api/health", "expectedStatus": 200 }
  },
  "context": {
    "outputPath": "/path/to/repo/CLAUDE.md"
  },
  "axon": {
    "enabled": false,
    "pythonBin": "python",
    "scriptPath": "./vendor/axon/src/axon/cli.py"
  }
}
```

Per-repo `scan` settings merge with (and override) global `scan` defaults. `additionalIgnore` patterns are appended to the global ignore list rather than replacing it.

### Environment Variables (Alternative)

If `cortex.config.json` is not present, these environment variables are used:

| Variable | Default | Description |
|----------|---------|-------------|
| `CORTEX_DB_HOST` | localhost | PostgreSQL host |
| `CORTEX_DB_PORT` | 5432 | PostgreSQL port |
| `CORTEX_DB_NAME` | postgres | Database name |
| `CORTEX_DB_USER` | postgres | Database user |
| `CORTEX_DB_PASSWORD` | (empty) | Database password |
| `CORTEX_DB_SSL` | false | Enable SSL |
| `CORTEX_OLLAMA_HOST` | http://localhost:11434 | Ollama host |
| `CORTEX_OLLAMA_MODEL` | nomic-embed-text | Embedding model |
| `CORTEX_OLLAMA_ENABLED` | true | Enable embeddings |
| `CORTEX_PORT` | 3131 | API server port |
| `CORTEX_HOST` | localhost | API server bind address |
| `CORTEX_API_KEY` | (empty) | API auth key |

See `cortex.config.example.json` for the full annotated configuration template.

## API Reference

Base URL: `http://localhost:3131` (configurable via `server.port`)

Authentication: If `server.apiKey` is set, all endpoints except `/status` require an `X-API-Key` header or `?api_key=` query parameter.

### System

#### `GET /status`
System status overview. No auth required.

**Response:**
```json
{
  "status": "ok",
  "version": "0.1.0",
  "database": { "connected": true },
  "repos": 3,
  "chunks": 15420,
  "reposWithData": 3,
  "recentErrors": 0,
  "lastUpdated": "2026-01-30T12:00:00.000Z"
}
```

### Repos

#### `GET /repos`
List all configured repos with scan stats (chunk count, file count, last scan time).

#### `GET /repos/:name/chunks`
Code chunks for a repo with optional filters.

| Query Param | Description |
|-------------|-------------|
| `file` | Filter by relative path (ILIKE match) |
| `type` | Filter by chunk_type (`function`, `class`, `const`, `block`, `file`) |
| `language` | Filter by language |
| `limit` | Max results, up to 500 (default: 50) |
| `offset` | Pagination offset |

#### `GET /repos/:name/graph`
Knowledge graph edges for a repo.

| Query Param | Description |
|-------------|-------------|
| `type` | Filter by edge_type (`import`, `route`, `db_query`) |
| `limit` | Max results, up to 2000 (default: 200) |

#### `GET /repos/:name/health`
Latest health snapshot per service for a repo.

### Search

#### `GET /search?q=term`
Full-text search across all code chunks.

| Query Param | Description |
|-------------|-------------|
| `q` | Search term (required, min 2 chars) |
| `repo` | Limit to a specific repo |
| `type` | Filter by chunk_type |
| `limit` | Max results, up to 100 (default: 20) |

### Actions

#### `POST /scan/:name`
Trigger a full scan + graph rebuild for a repo. Returns immediately (fire-and-forget). The scan runs in the background.

#### `POST /health/:name`
Trigger health checks for a repo. Returns results synchronously.

#### `POST /dump/:name`
Generate and write CLAUDE.md for a repo. Returns the output path.

### Work Log

#### `POST /work-log`
Log a work entry.

**Body:**
```json
{
  "repo": "my-api",
  "category": "feature",
  "summary": "Added user authentication",
  "files_touched": ["src/auth.js", "src/routes/login.js"],
  "status": "completed"
}
```

#### `POST /work-log/session-start`
Start a work session. Returns a `session_id`.

#### `POST /work-log/session-end`
End a work session. Accepts `session_id`, `summary`, and `result`.

#### `GET /work-log/compact`
Get recent work log entries in a compact format for context injection.

## Architecture

### Pipeline: Scan, Chunk, Embed, Graph

```
cortex.config.json
       |
       v
  src/config.js ─────────────────────────────────────────┐
       |                                                   |
       ├──> src/scan/file-walker.js  (glob, detect lang)   |
       |           |                                       |
       |           v                                       |
       |    src/scan/chunker.js  (JS/TS/Python/SQL/MD)    |
       |           |                                       |
       |           v                                       |
       ├──> src/scan/index.js  ──> Ollama (embeddings)    |
       |           |                                       |
       |           v                                       |
       |    PostgreSQL: cortex.code_chunks                 |
       |           |                                       |
       ├──> src/graph/builder.js (imports, routes, SQL)    |
       |           |                                       |
       |           v                                       |
       |    PostgreSQL: cortex.graph_edges                 |
       |           |                                       |
       ├──> src/check/snapshot.js (HTTP/TCP/Docker)        |
       |           |                                       |
       |           v                                       |
       |    PostgreSQL: cortex.health_snapshots            |
       |           |                                       |
       └──> src/dump/claude-md.js  ──> CLAUDE.md          |
                                                           |
  server.js: Express API + chokidar + node-cron ──────────┘
```

### Scanning

1. **File walking** (`src/scan/file-walker.js`): Globs for source files by extension, skips files >1MB, detects language from extension (50+ extensions mapped).
2. **Chunking** (`src/scan/chunker.js`): Language-aware splitting:
   - **JavaScript/TypeScript**: Splits on `function`, `class`, `const`, `interface`, `type`, `enum` declarations
   - **Python**: Splits on `def` and `class` definitions
   - **SQL**: Splits on `CREATE`, `ALTER`, `INSERT`, `SELECT` statements
   - **Markdown**: Splits on heading levels (h1-h4)
   - **Other languages**: Fixed-size blocks (80 lines, 5-line overlap)
3. **Upserting** (`src/scan/index.js`): For each chunk, computes MD5 hash. Skips if hash is unchanged and embedding already exists. Otherwise calls Ollama for embedding and upserts. Processes files in parallel (concurrency configurable, default: 4).
4. **Stale cleanup**: After scanning, deletes chunks for files no longer present in the repo.

### Incremental Updates

chokidar watches each repo directory. On file change/add/delete:
- 1-second debounce per file (avoids repeated writes during saves)
- Re-chunks and upserts just the changed file
- On delete: removes all chunks for that file path

### Graph Building

`src/graph/builder.js` extracts edges from chunk content:

| Edge Type | Detection |
|-----------|-----------|
| `import` | ES module `import`, `require()`, Python `import`/`from` |
| `route` | Express/Fastify `router.get()`, Flask `@app.route()`, FastAPI `@router.get()` |
| `db_query` | SQL `FROM`, `JOIN`, `INSERT INTO`, `UPDATE`, `DELETE FROM`, `CREATE TABLE` |

Table references also populate `cortex.table_ownership`.

### Health Checks

| Check Type | How | When to Use |
|------------|-----|-------------|
| `http` | `fetch()` GET, checks response status | REST APIs, web services |
| `tcp` | `net.createConnection()` | Databases, Redis, raw TCP |
| `docker` | `docker inspect <container>` | Docker containers |

Retries up to `health.retries` times (default: 2) with 500ms x attempt backoff. Results stored in `cortex.health_snapshots`. Default schedule: every 15 minutes.

### CLAUDE.md Generation

`src/dump/claude-md.js` queries the database and produces sections:

| Section | Source |
|---------|--------|
| Scan Summary | `code_chunks` aggregates (files, chunks, tokens, languages) |
| Language Breakdown | `GROUP BY language` |
| Key Files | Top N files by chunk count |
| Key Symbols | Largest functions/classes by token estimate |
| API Routes | `graph_edges WHERE edge_type = 'route'` |
| Database Tables | `table_ownership` ordered by reference count |
| External Dependencies | `graph_edges WHERE edge_type = 'import'` (external only) |
| Knowledge Graph | Edge type counts from `graph_edges` |
| Service Health | Latest row per service from `health_snapshots` |
| Recent Errors | Last 10 rows from `errors` |

Output path defaults to `{repo.path}/CLAUDE.md`. Override with `repos[].context.outputPath`.

## Database Schema

Seven tables in the `cortex` PostgreSQL schema:

| Table | Purpose |
|-------|---------|
| `code_chunks` | Source code chunks with embeddings (768-dim pgvector) |
| `graph_edges` | Import/route/DB relationship edges |
| `health_snapshots` | Service health check history |
| `errors` | Scan/embed/health runtime error log |
| `scan_log` | Scan run history (duration, file counts, status) |
| `table_ownership` | SQL table-to-repo mapping |
| `work_log` | Persistent work history — git commits, session tracking |

### Key: `code_chunks`

| Column | Type | Description |
|--------|------|-------------|
| `repo_name` | text | Matches `repos[].name` in config |
| `relative_path` | text | Relative to repo root (forward slashes) |
| `chunk_name` | text | Function/class/symbol name |
| `chunk_type` | text | `function`, `class`, `interface`, `const`, `block`, `file` |
| `language` | text | Detected language |
| `content` | text | Raw source code |
| `content_hash` | text | MD5 for change detection |
| `embedding` | vector(768) | nomic-embed-text embedding (nullable) |
| `token_estimate` | int | Rough token count (`ceil(content.length / 4)`) |

Unique constraint: `(repo_name, relative_path, chunk_name, chunk_type)`

### Key: `work_log`

| Column | Type | Description |
|--------|------|-------------|
| `repo` | text | Repository name |
| `session_id` | text | Groups entries by session |
| `category` | text | `feature`, `fix`, `refactor`, `build`, `config`, `error`, `test` |
| `summary` | text | What was done |
| `files_touched` | text[] | Files modified |
| `status` | text | `completed`, `in_progress`, `failed`, `blocked` |
| `commit_hash` | text | Git commit (unique, deduped) |

## Work Log

Context Cortex tracks all work done across repos via the `work_log` table. This data is auto-injected into generated CLAUDE.md files so every Claude Code session starts knowing exactly what happened in recent sessions.

### How It Works

1. **Git commit auto-logging**: The server watches for git commits and logs them with commit hash, summary, and affected files.
2. **Session tracking**: Use `POST /work-log/session-start` and `POST /work-log/session-end` to bracket work sessions.
3. **Manual logging**: Use `POST /work-log` to log significant changes as you work.
4. **CLAUDE.md injection**: When CLAUDE.md is regenerated, recent work log entries are included so the next session has full context.

### Session Protocol

Add this to your project's CLAUDE.md to instruct Claude Code to use the work log:

```bash
# Start a session
curl -s -X POST http://localhost:3131/work-log/session-start \
  -H "X-API-Key: YOUR_KEY" -H "Content-Type: application/json" \
  -d '{"repo":"my-api","summary":"Describe your task"}'

# Log significant changes
curl -s -X POST http://localhost:3131/work-log \
  -H "X-API-Key: YOUR_KEY" -H "Content-Type: application/json" \
  -d '{"repo":"my-api","category":"feature","summary":"What you did","files_touched":["file.js"],"status":"completed"}'

# End the session
curl -s -X POST http://localhost:3131/work-log/session-end \
  -H "X-API-Key: YOUR_KEY" -H "Content-Type: application/json" \
  -d '{"repo":"my-api","summary":"What you accomplished","result":"completed"}'
```

## Operational Commands

```bash
# First-time setup (schema + scan + graph + health + CLAUDE.md)
npm run setup

# Start the server (API + file watchers + cron jobs)
npm start

# Manual full scan (all repos)
npm run scan

# Manual scan (specific repo)
node scripts/full-scan.js my-api

# Scan without graph rebuild
node scripts/full-scan.js my-api --no-graph

# Scan without CLAUDE.md generation
node scripts/full-scan.js my-api --no-dump

# Run health checks
npm run health
node scripts/health-check.js my-api
node scripts/health-check.js --json

# Reset schema (WARNING: deletes all data)
npm run reset
node scripts/reset.js --force

# API calls
curl http://localhost:3131/status
curl http://localhost:3131/repos
curl "http://localhost:3131/search?q=runScan"
curl -X POST http://localhost:3131/scan/my-api
curl -X POST http://localhost:3131/dump/my-api
```

## Axon Integration (Optional)

[Axon](https://github.com/context-cortex/axon-main) is an optional Python backend for AST-level code analysis. When enabled, it replaces the regex chunker with accurate AST-based chunk extraction.

```bash
# Install Axon
cp -r /path/to/axon-main ./vendor/axon
cd vendor/axon && pip install -e .
```

Enable per-repo in `cortex.config.json`:
```json
{
  "axon": {
    "enabled": true,
    "pythonBin": "python",
    "scriptPath": "./vendor/axon/src/axon/cli.py"
  }
}
```

If Axon fails or is unavailable, the scanner falls back to the regex chunker automatically.

## License

MIT
