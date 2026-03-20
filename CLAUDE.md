# Context Cortex -- System Specification

> This is the authoritative specification and developer context for the Context Cortex codebase.
> It serves as both project documentation AND Claude Code instructions.

---

## What Is Context Cortex?

Context Cortex is a reusable code intelligence tool for Claude Code that:

1. **Scans** any codebase using configurable glob patterns
2. **Chunks** source files into semantic units (functions, classes, blocks)
3. **Embeds** each chunk using Ollama (`nomic-embed-text`, 768 dims)
4. **Stores** chunks + embeddings in PostgreSQL with pgvector
5. **Builds** a knowledge graph (imports, routes, DB queries)
6. **Generates** `CLAUDE.md` context files for Claude Code
7. **Monitors** service health and snapshots results
8. **Watches** file changes (chokidar) for incremental updates
9. **Tracks work** via `work_log` table with git commit auto-logging and session tracking
10. **Auto-injects context** into CLAUDE.md so every session starts informed

It is designed to be repo-agnostic. Point it at any codebase and it will produce structured intelligence.

---

## Quick Start (3 commands)

```bash
# 1. Install dependencies
npm install

# 2. Configure
cp cortex.config.example.json cortex.config.json
# Edit cortex.config.json with your DB credentials and repo paths

# 3. First-time setup (schema + scan + graph + health + CLAUDE.md)
npm run setup
```

After setup, run the server:
```bash
npm start
# API available at http://localhost:3131
```

---

## Project Structure

```
context-cortex/
├── server.js                  -- Express server, cron jobs, chokidar watchers
├── cortex.config.json         -- Your config (gitignored)
├── cortex.config.example.json -- Config template with all options documented
│
├── src/
│   ├── config.js              -- Config loader + validator + env var fallback
│   ├── db/
│   │   ├── connection.js      -- PG pool, runSchema(), externalPool(), withTransaction()
│   │   └── schema.sql         -- 7 tables in cortex schema (includes work_log)
│   ├── scan/
│   │   ├── file-walker.js     -- Glob-based file discovery, language detection (50+ extensions)
│   │   ├── chunker.js         -- Semantic chunking (JS/TS/Python/SQL/Markdown + fallback)
│   │   └── index.js           -- Orchestrator: walk -> chunk -> hash -> embed -> upsert
│   ├── check/
│   │   └── snapshot.js        -- HTTP/TCP/Docker health checks -> health_snapshots
│   ├── graph/
│   │   └── builder.js         -- Extract import/route/DB edges -> graph_edges + table_ownership
│   ├── dump/
│   │   └── claude-md.js       -- Query DB -> generate CLAUDE.md markdown (10+ sections)
│   └── api/
│       └── routes.js          -- Express router: 10 endpoints + work-log endpoints
│
├── scripts/
│   ├── setup.js               -- First-time init (schema + scan + graph + health + CLAUDE.md)
│   ├── full-scan.js           -- Manual scan (all repos or one, --no-graph, --no-dump flags)
│   ├── reset.js               -- Drop and recreate cortex schema (destructive)
│   └── health-check.js        -- Run health checks (all repos or one, --json flag)
│
└── vendor/
    └── axon/                  -- Optional: Axon Python code intelligence backend
```

---

## Configuration Reference

Configuration lives in `cortex.config.json` (gitignored). See `cortex.config.example.json` for the full annotated template.

### Top-level fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `database` | object | yes | PostgreSQL connection config |
| `repos` | array | yes | List of repos to scan (each needs `name` + `path`) |
| `ollama` | object | no | Embedding config (enabled by default) |
| `scan` | object | no | Global scan defaults (overridable per-repo) |
| `health` | object | no | Health check schedule + timeouts |
| `context` | object | no | CLAUDE.md generation settings |
| `server` | object | no | HTTP API settings (port, host, apiKey) |

### `database`

```json
{
  "host": "localhost",
  "port": 5432,
  "database": "postgres",
  "user": "postgres",
  "password": "secret",
  "ssl": false,
  "max": 10,
  "idleTimeoutMillis": 30000,
  "connectionTimeoutMillis": 5000
}
```

### `ollama`

```json
{
  "enabled": true,
  "host": "http://localhost:11434",
  "model": "nomic-embed-text",
  "dimensions": 768,
  "timeoutMs": 30000
}
```

Set `enabled: false` to skip embedding generation. Chunks are still stored as text. Full-text search works, but vector similarity search will not.

### `scan` (global defaults, overridable per-repo)

```json
{
  "concurrency": 4,
  "chunkSizeLines": 80,
  "chunkOverlapLines": 5,
  "embedChunks": true,
  "hashAlgorithm": "md5",
  "ignorePatterns": ["node_modules/**", ".git/**", "dist/**"],
  "includeExtensions": [".js", ".ts", ".py", ".go", ".sql", ".md"]
}
```

### `repos[]`

```json
{
  "name": "my-api",
  "path": "/absolute/path/to/repo",
  "description": "Optional description",
  "language": "javascript",
  "scan": {
    "enabled": true,
    "schedule": "0 */6 * * *",
    "additionalIgnore": ["tmp/**"]
  },
  "services": {
    "postgres": { "type": "tcp", "host": "localhost", "port": 5432 },
    "api": { "type": "http", "url": "http://localhost:3000/health" }
  },
  "context": {
    "outputPath": "/path/to/repo/CLAUDE.md"
  },
  "axon": { "enabled": false }
}
```

### `server`

```json
{
  "port": 3131,
  "host": "localhost",
  "apiKey": "optional-api-key"
}
```

If `apiKey` is set, all endpoints except `/status` require `X-API-Key` header or `?api_key=` query param.

### Environment variable fallback

If `cortex.config.json` is missing, config is read from `CORTEX_DB_HOST`, `CORTEX_DB_PORT`, `CORTEX_DB_NAME`, `CORTEX_DB_USER`, `CORTEX_DB_PASSWORD`, `CORTEX_DB_SSL`, `CORTEX_OLLAMA_HOST`, `CORTEX_OLLAMA_MODEL`, `CORTEX_OLLAMA_ENABLED`, `CORTEX_PORT`, `CORTEX_HOST`, `CORTEX_API_KEY`.

---

## Schema Design

All tables live in the `cortex` schema. Requires PostgreSQL 14+ and pgvector.

### `cortex.code_chunks`
Core table. One row per semantic chunk of code.

| Column | Type | Description |
|--------|------|-------------|
| `id` | bigserial | PK |
| `repo_name` | text | Matches `repos[].name` in config |
| `file_path` | text | Absolute path |
| `relative_path` | text | Relative to repo root (normalized forward slashes) |
| `chunk_name` | text | Function/class/symbol name |
| `chunk_type` | text | `function`, `class`, `interface`, `const`, `block`, `file`, `section` |
| `language` | text | Detected language |
| `content` | text | Raw source code |
| `content_hash` | text | MD5 for change detection |
| `start_line` | int | 1-indexed |
| `end_line` | int | 1-indexed, inclusive |
| `file_size` | bigint | Bytes |
| `file_mtime` | timestamptz | File modification time |
| `embedding` | vector(768) | nomic-embed-text embedding (nullable) |
| `token_estimate` | int | `ceil(content.length / 4)` |
| `meta` | jsonb | Extension metadata |

**Unique constraint:** `(repo_name, relative_path, chunk_name, chunk_type)`

**Indexes:** repo_name, full-text on content+name, IVFFlat vector index (100 lists)

### `cortex.graph_edges`
Directed edges in the knowledge graph.

| Column | Type | Description |
|--------|------|-------------|
| `source_chunk_id` | bigint | FK -> code_chunks |
| `target_chunk_id` | bigint | FK -> code_chunks (nullable for external refs) |
| `edge_type` | text | `import`, `route`, `db_query`, `calls`, `defines` |
| `label` | text | Import path, route path, SQL table, etc. |

### `cortex.health_snapshots`
Point-in-time health check results.

| Column | Type | Description |
|--------|------|-------------|
| `service_name` | text | Key from `repos[].services` |
| `service_type` | text | `http`, `tcp`, `docker` |
| `status` | text | `ok`, `degraded`, `down`, `unknown` |
| `latency_ms` | int | Round-trip ms |
| `status_code` | int | HTTP status (if applicable) |

### `cortex.errors`
Runtime errors from scan/embed/health operations. Used for observability. Columns: repo_name, operation (`scan`/`embed`/`health`/`graph`/`dump`), file_path, message, stack, meta.

### `cortex.scan_log`
Record of each scan run: repo_name, scan_type (`full`/`incremental`/`file`), status, files_scanned, chunks_upserted, chunks_deleted, errors_count, duration_ms.

### `cortex.table_ownership`
Maps SQL table names to the repos that reference them. Auto-populated by `graph/builder.js` when SQL patterns are detected. Tracks schema_name, access_type (`readonly`/`readwrite`/`owner`), and detected_in (file paths array).

### `cortex.work_log`
Persistent log of all work done across repos. Auto-injected into CLAUDE.md so every Claude Code session starts knowing what happened before.

| Column | Type | Description |
|--------|------|-------------|
| `repo` | text | Repository name |
| `session_id` | text | Groups entries by work session |
| `category` | text | `feature`, `fix`, `refactor`, `build`, `config`, `error`, `test` |
| `summary` | text | What was done |
| `files_touched` | text[] | Files modified |
| `endpoints_affected` | text[] | API endpoints changed |
| `tables_affected` | text[] | DB tables touched |
| `status` | text | `completed`, `in_progress`, `failed`, `blocked` |
| `commit_hash` | text | Git commit hash (unique constraint for dedup) |

---

## How Scanning Works

### File Walking (`src/scan/file-walker.js`)

1. Uses `glob` v11 with extension-based patterns: `**/*.{js,ts,py,...}`
2. Applies ignore patterns from config (node_modules, .git, dist, etc.)
3. Skips files >1MB (generated/binary) and empty files
4. Detects language from extension (50+ extensions mapped)
5. Returns sorted `{path, relativePath, size, mtime, language}` array

### Chunking (`src/scan/chunker.js`)

Language-aware strategies:

- **JavaScript/TypeScript**: Splits on `function`, `class`, `const`, `interface`, `type`, `enum` declarations
- **Python**: Splits on `def` and `class` definitions
- **SQL**: Splits on `CREATE`, `ALTER`, `INSERT`, `SELECT`, `UPDATE`, `DELETE` statements
- **Markdown**: Splits on heading levels (h1-h4)
- **Other**: Fixed-size blocks (80 lines, 5-line overlap)

Files smaller than `chunkSizeLines` are returned as a single `file` chunk.

### Upsert Logic (`src/scan/index.js`)

For each file:
1. Load existing chunk hashes from DB for that file
2. For each chunk: compute MD5 of content
3. Skip if `content_hash` unchanged AND embedding exists
4. Otherwise: get embedding from Ollama, upsert row
5. After all files: delete chunks for paths no longer in the repo

Concurrency: `scan.concurrency` files processed in parallel (default: 4).

### Incremental Watching

`chokidar` watches each repo directory. On file change/add/delete:
- 1-second debounce per file (avoids repeated writes during saves)
- Calls `scanFile()` which re-chunks and upserts just that file
- On delete: removes all chunks for that relative path

---

## How the Knowledge Graph Works

### Edge Extraction (`src/graph/builder.js`)

Processes every chunk in a repo and detects:

| Edge Type | Detection Patterns |
|-----------|-------------------|
| `import` | ES `import ... from`, `require()`, Python `import`/`from ... import` |
| `route` | Express/Fastify `router.get()` etc., Flask `@app.route()`, FastAPI `@router.get()` |
| `db_query` | SQL `FROM`, `JOIN`, `INSERT INTO`, `UPDATE`, `DELETE FROM`, `CREATE TABLE/VIEW` |

Import edges link source chunk to target chunk (resolved within repo). Route edges store the route path as label. DB query edges also populate `table_ownership`.

---

## How Health Checks Work

### Check types

| Type | How | When to use |
|------|-----|-------------|
| `http` | `fetch()` GET, checks response status | REST APIs, web services |
| `tcp` | `net.createConnection()` | Databases, Redis, raw TCP services |
| `docker` | `docker inspect <container>` | Docker containers |

### Retry logic
Each check retries up to `health.retries` times (default: 2) with 500ms x attempt backoff. Only retries on failure.

### Schedule
Default: `*/15 * * * *` (every 15 minutes). Override in `health.schedule`.

---

## CLAUDE.md Generation

`src/dump/claude-md.js` queries the DB to produce sections:

| Section | Source |
|---------|--------|
| Scan Summary | `code_chunks` aggregates |
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

Regenerate on demand:
```bash
node scripts/full-scan.js my-api       # scan + rebuild graph + regenerate CLAUDE.md
curl -X POST http://localhost:3131/dump/my-api  # via API
```

---

## Work Log System

The `work_log` table provides persistent cross-session memory for Claude Code.

### What gets logged
- **Git commits**: Auto-detected from commit history. Deduped by `commit_hash`.
- **Session starts/ends**: Bracket work sessions with session_id for grouping.
- **Manual entries**: Log significant changes mid-session.

### How it flows into CLAUDE.md
When CLAUDE.md is regenerated, recent work log entries (grouped by day) are injected. This gives the next Claude Code session a "Recent Work" section showing exactly what happened in the last 7 days, including commit messages, categories, and status.

### Session protocol (for CLAUDE.md instructions)
```bash
# SESSION START
curl -X POST http://localhost:3131/work-log/session-start \
  -H "Content-Type: application/json" \
  -d '{"repo":"my-api","summary":"task description"}'

# LOG CHANGES
curl -X POST http://localhost:3131/work-log \
  -H "Content-Type: application/json" \
  -d '{"repo":"my-api","category":"fix","summary":"what you did","files_touched":["file.js"]}'

# SESSION END
curl -X POST http://localhost:3131/work-log/session-end \
  -H "Content-Type: application/json" \
  -d '{"repo":"my-api","summary":"outcome","result":"completed"}'
```

---

## API Reference

Base URL: `http://localhost:3131`

Authentication: `X-API-Key: your-key` header or `?api_key=your-key` (only if `server.apiKey` is set).

### `GET /status`
System status. No auth required.

```json
{
  "status": "ok",
  "version": "0.1.0",
  "database": { "connected": true },
  "repos": 3,
  "chunks": 15420,
  "lastUpdated": "2025-01-30T12:00:00Z"
}
```

### `GET /repos`
List all configured repos with scan stats.

### `GET /repos/:name/chunks`
Code chunks for a repo. Query params: `file`, `type`, `language`, `limit` (max 500), `offset`.

### `GET /repos/:name/graph`
Knowledge graph edges. Query params: `type`, `limit` (max 2000).

### `GET /repos/:name/health`
Latest health snapshot per service.

### `GET /search?q=term`
Full-text search across code chunks. Query params: `q` (required, min 2 chars), `repo`, `type`, `limit` (max 100).

### `POST /scan/:name`
Trigger scan + graph build (fire-and-forget).

### `POST /health/:name`
Trigger health checks (synchronous).

### `POST /dump/:name`
Generate and write CLAUDE.md.

### `POST /work-log`
Log a work entry. Body: `{repo, category, summary, files_touched, status}`.

### `POST /work-log/session-start`
Start a session. Body: `{repo, summary}`. Returns `session_id`.

### `POST /work-log/session-end`
End a session. Body: `{repo, summary, result}`.

### `GET /work-log/compact`
Recent work log in compact format for context injection.

---

## Axon Integration (Optional Python Backend)

[Axon](https://github.com/context-cortex/axon-main) provides AST-level code analysis as an alternative to the regex chunker.

### Setup
```bash
cp -r /path/to/axon-main ./vendor/axon
cd vendor/axon && pip install -e .
```

### Configuration (per-repo)
```json
{
  "axon": {
    "enabled": true,
    "pythonBin": "python",
    "scriptPath": "./vendor/axon/src/axon/cli.py"
  }
}
```

When enabled, the scanner calls Axon as a subprocess:
```
python vendor/axon/src/axon/cli.py scan --path /repo --format json
```

Axon outputs JSON with AST-level chunks (accurate function boundaries, docstrings, parameter lists). Falls back to regex chunker if Axon fails.

---

## Build Order (for extending)

### Database changes
1. Edit `src/db/schema.sql` -- add tables, columns, or indexes
2. Run `npm run reset` to apply (dev) or write a migration script (prod)

### New language support in chunker
3. Add extension to `EXT_TO_LANGUAGE` map in `src/scan/file-walker.js`
4. Add regex pattern set to `PATTERNS` in `src/scan/chunker.js`
5. Add language alias if needed (e.g., `PATTERNS.jsx = PATTERNS.javascript`)

### New graph edge type
6. Define regex patterns in `src/graph/builder.js`
7. Add extractor function following the `extractImports` / `extractRoutes` pattern
8. Call new extractor in `processChunk()`
9. Add aggregation to `getGraphStats()` in `src/dump/claude-md.js`
10. Add display section in `generateClaudeMd()`

### New health check type
11. Add handler function in `src/check/snapshot.js` following `checkHttp` / `checkTcp` pattern
12. Add case to the `switch (type)` in `checkService()`

### New API endpoint
13. Add route handler in `src/api/routes.js`
14. Use `asyncHandler()` wrapper for async routes
15. Use `requireAuth` middleware for protected endpoints

### New scan option
16. Add field to `defaultScanConfig()` in `src/config.js`
17. Document in `cortex.config.example.json`
18. Consume in `src/scan/index.js` or `src/scan/chunker.js`

### CLAUDE.md customization
19. Add new query function in `src/dump/claude-md.js`
20. Call in the `Promise.all` array in `generateClaudeMd()`
21. Add markdown section builder

### Adding a new repo
22. Add entry to `repos[]` in `cortex.config.json`
23. Run `node scripts/full-scan.js my-new-repo` to scan immediately

---

## Key Conventions

- **ES modules everywhere** (`"type": "module"` in package.json). Use `.js` extensions in all imports.
- **Windows path safety**: Use `path.join()` everywhere. Never hardcode `/` separators.
- **Relative paths use forward slashes**: Normalize with `.replace(/\\/g, '/')` on Windows.
- **No hardcoded data**: Return null/empty arrays, not fake fallback values.
- **Error logging**: Use `logError()` from `db/connection.js` for non-fatal errors. Do not throw -- continue with other files.
- **Pool management**: Scripts must call `closePool()` before `process.exit()`.
- **Embeddings are nullable**: Always check for null embedding. Full-text search works without them.
- **content_hash deduplication**: If `content_hash` is unchanged and embedding exists, skip upsert. Saves DB writes and Ollama calls.
- **Cron validation**: Always call `cron.validate(schedule)` before scheduling.
- **Config comments**: Keys starting with `_` (like `_comment`, `_readme`) are stripped during config loading.

---

## Known Gotchas

### pgvector may not be installed
- Symptom: `runSchema()` fails with "extension vector does not exist"
- Solution: `src/db/connection.js` catches this and falls back to `TEXT` column for embedding. Install pgvector for vector search: `apt install postgresql-16-pgvector`

### IVFFlat index requires data before creation
- Symptom: `CREATE INDEX USING ivfflat` fails on empty table
- Solution: The index creation in `schema.sql` uses `IF NOT EXISTS` and will succeed on empty tables. Run `VACUUM ANALYZE cortex.code_chunks` after first data load for optimal performance.

### Windows glob patterns
- Symptom: Paths returned with backslashes break `relative_path` uniqueness
- Solution: `file-walker.js` normalizes all paths with `.replace(/\\/g, '/')`

### Chokidar on Windows with network drives
- Symptom: File changes on network drives not detected
- Solution: Set `usePolling: true` in the chokidar config in `server.js`

### Large repos (100k+ files)
- Symptom: Initial scan takes very long
- Solution: Increase `concurrency`, narrow `includeExtensions`, add more `ignorePatterns`

### Ollama timeout on large chunks
- Symptom: Embedding fails with AbortError for very large chunks
- Solution: Increase `ollama.timeoutMs`, or reduce `chunkSizeLines` to produce smaller chunks

---

## Operational Commands

```bash
# First-time setup
npm run setup

# Manual full scan (all repos)
npm run scan

# Manual scan (specific repo)
node scripts/full-scan.js my-api

# Manual scan without graph rebuild
node scripts/full-scan.js my-api --no-graph

# Manual scan without CLAUDE.md generation
node scripts/full-scan.js my-api --no-dump

# Run health checks
npm run health
node scripts/health-check.js my-api
node scripts/health-check.js --json

# Reset schema (WARNING: deletes all data)
npm run reset
node scripts/reset.js --force

# Start server
npm start

# API calls
curl http://localhost:3131/status
curl http://localhost:3131/repos
curl "http://localhost:3131/search?q=runScan"
curl -X POST http://localhost:3131/scan/my-api
curl -X POST http://localhost:3131/dump/my-api
```

---

## Setting Up Context Cortex for a New Project

When a user asks you to set up Context Cortex for their project, follow these steps:

1. **Detect the project**: Run `ls` to see the project structure. Note the language, entry points, and any services (databases, APIs).

2. **Check prerequisites**:
   - PostgreSQL running? `psql -c "SELECT 1"` or check with `pg_isready`
   - pgvector installed? `psql -c "CREATE EXTENSION IF NOT EXISTS vector;"`
   - Ollama running? `curl -s http://localhost:11434/api/tags`
   - Model pulled? `ollama pull nomic-embed-text`

3. **Generate config**: Create `cortex.config.json` in the context-cortex directory with:
   - Database connection details
   - The user's repo(s) with path, name, language, entry points
   - Any services to monitor

4. **Run setup**: `cd /path/to/context-cortex && npm run setup`

5. **Add MCP server**: Create `.mcp.json` in the user's project root:
   ```json
   {
     "mcpServers": {
       "context-cortex": {
         "command": "node",
         "args": ["/path/to/context-cortex/mcp-server.js"],
         "env": { "CORTEX_CONFIG": "/path/to/context-cortex/cortex.config.json" }
       }
     }
   }
   ```

6. **Verify**: Tell the user to restart Claude Code, then call `cortex_system_status`.

7. **Explain**: Tell the user what was set up and what happens automatically (file watching, cron scans, CLAUDE.md regeneration every 4 hours).

---

## Services

| Component | Default Port | Notes |
|-----------|-------------|-------|
| HTTP API | 3131 | Express, configurable via `server.port` |
| PostgreSQL | 5432 | cortex schema, 7 tables |
| Ollama | 11434 | nomic-embed-text (768 dims) |
