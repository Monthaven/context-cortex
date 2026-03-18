# Context Cortex — System Specification

> This is the authoritative specification and developer context for the Context Cortex codebase.
> It covers architecture, schema, extension patterns, and operational notes.

---

## What Is Context Cortex?

Context Cortex is an autonomous code intelligence system that:

1. **Scans** any codebase using configurable glob patterns
2. **Chunks** source files into semantic units (functions, classes, blocks)
3. **Embeds** each chunk using Ollama (`nomic-embed-text`, 768 dims)
4. **Stores** chunks + embeddings in PostgreSQL with pgvector
5. **Builds** a knowledge graph (imports, routes, DB queries)
6. **Generates** `CLAUDE.md` context files for Claude Code
7. **Monitors** service health and snapshots results
8. **Watches** file changes (chokidar) for incremental updates

It is designed to be repo-agnostic. Point it at any codebase and it will produce structured intelligence about that codebase.

---

## Quick Start (3 commands)

```bash
# 1. Install dependencies
npm install

# 2. Configure
cp cortex.config.example.json cortex.config.json
# Edit cortex.config.json with your DB credentials and repo paths

# 3. First-time setup (schema + scan + CLAUDE.md)
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
├── server.js                  — Express server, cron jobs, chokidar watchers
├── cortex.config.json         — Your config (gitignored)
├── cortex.config.example.json — Config template
│
├── src/
│   ├── config.js              — Config loader + validator
│   ├── db/
│   │   ├── connection.js      — PG pool, runSchema(), externalPool(), withTransaction()
│   │   └── schema.sql         — 6 tables in cortex schema
│   ├── scan/
│   │   ├── file-walker.js     — Glob-based file discovery, language detection
│   │   ├── chunker.js         — Semantic chunking (JS/TS/Python/SQL/Markdown)
│   │   └── index.js           — Orchestrator: walk → chunk → upsert → embed
│   ├── check/
│   │   └── snapshot.js        — HTTP/TCP/Docker health checks → health_snapshots
│   ├── graph/
│   │   └── builder.js         — Extract import/route/DB edges → graph_edges
│   ├── dump/
│   │   └── claude-md.js       — Query DB → generate CLAUDE.md markdown
│   └── api/
│       └── routes.js          — Express router (10 endpoints)
│
├── scripts/
│   ├── setup.js               — First-time init (schema + scan + graph + CLAUDE.md)
│   ├── full-scan.js           — Manual scan (all repos or one)
│   ├── reset.js               — Drop and recreate cortex schema
│   └── health-check.js        — Run health checks (all repos or one)
│
└── vendor/
    └── axon/                  — Optional: Axon Python code intelligence backend
```

---

## Configuration Reference

Configuration lives in `cortex.config.json` (gitignored). See `cortex.config.example.json` for the full template.

### Top-level fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `database` | object | yes | PostgreSQL connection config |
| `repos` | array | yes | List of repos to scan |
| `ollama` | object | no | Embedding config (enabled by default) |
| `scan` | object | no | Global scan defaults |
| `health` | object | no | Health check schedule |
| `context` | object | no | CLAUDE.md generation settings |
| `server` | object | no | HTTP API settings |

### `database`

```json
{
  "host": "localhost",
  "port": 5432,
  "database": "postgres",
  "user": "postgres",
  "password": "secret",
  "ssl": false,
  "max": 10
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

Set `enabled: false` to skip embedding generation. Chunks are still stored as text — full-text search still works, but vector similarity search won't.

### `scan` (global defaults, overridable per-repo)

```json
{
  "concurrency": 4,
  "chunkSizeLines": 80,
  "chunkOverlapLines": 5,
  "embedChunks": true,
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
  "axon": {
    "enabled": false
  }
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

---

## Schema Design

All tables live in the `cortex` schema. Requires PostgreSQL 14+ and pgvector.

### `cortex.code_chunks`
Core table. One row per semantic chunk.

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
| `source_chunk_id` | bigint | FK → code_chunks |
| `target_chunk_id` | bigint | FK → code_chunks (nullable for external refs) |
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
Runtime errors from scan/embed/health operations. Used for observability.

### `cortex.scan_log`
Record of each scan run: timestamps, file counts, duration.

### `cortex.table_ownership`
Maps SQL table names to the repos that reference them.
Auto-populated by `graph/builder.js` when SQL patterns are detected.

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
- **Markdown**: Splits on heading levels (h1–h4)
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

## How Health Checks Work

### Check types

| Type | How | When to use |
|------|-----|-------------|
| `http` | `fetch()` GET, checks response status | REST APIs, web services |
| `tcp` | `net.createConnection()` | Databases, Redis, raw TCP services |
| `docker` | `docker inspect <container>` | Docker containers |

### Retry logic

Each check retries up to `health.retries` times (default: 2) with 500ms×attempt backoff. Only retries on failure — success stops immediately.

### Snapshots

Every check result is stored to `cortex.health_snapshots`. Latest per service is shown in CLAUDE.md. History is queryable via API.

### Schedule

Default: `*/15 * * * *` (every 15 minutes). Override in `health.schedule` using node-cron syntax.

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
Code chunks for a repo.

Query params:
- `file` — filter by relative path (ILIKE)
- `type` — filter by chunk_type
- `language` — filter by language
- `limit` — max 500 (default 50)
- `offset` — pagination

### `GET /repos/:name/graph`
Knowledge graph edges.

Query params:
- `type` — filter by edge_type (`import`, `route`, `db_query`)
- `limit` — max 2000 (default 200)

### `GET /repos/:name/health`
Latest health snapshot per service.

### `GET /search?q=term`
Full-text search across all code chunks.

Query params:
- `q` — search term (required, min 2 chars)
- `repo` — limit to specific repo
- `type` — filter by chunk_type
- `limit` — max 100 (default 20)

### `POST /scan/:name`
Trigger a full scan + graph build for a repo. Returns immediately (fire-and-forget).

### `POST /health/:name`
Trigger health checks for a repo. Returns results synchronously.

### `POST /dump/:name`
Generate and write CLAUDE.md for a repo. Returns output path.

---

## CLAUDE.md Generation Logic

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

The output file path defaults to `{repo.path}/CLAUDE.md`. Override with `repos[].context.outputPath`.

Regenerate on demand:
```bash
node scripts/full-scan.js my-api       # scan + rebuild graph + regenerate CLAUDE.md
curl -X POST http://localhost:3131/dump/my-api  # via API
```

---

## Axon Integration (Optional Python Backend)

[Axon](https://github.com/context-cortex/axon-main) is a Python code intelligence engine that provides deeper AST-level analysis than the regex-based chunker.

### Setup

Axon is shipped as a git submodule / vendor copy at `vendor/axon/`.

```bash
# Copy Axon into vendor
cp -r /path/to/axon-main ./vendor/axon

# Install Axon dependencies
cd vendor/axon && pip install -e .
```

### Configuration

Per-repo:
```json
{
  "axon": {
    "enabled": true,
    "pythonBin": "python",
    "scriptPath": "./vendor/axon/src/axon/cli.py"
  }
}
```

### How it works

When `axon.enabled = true`, the scanner calls Axon as a subprocess:
```
python vendor/axon/src/axon/cli.py scan --path /repo --format json
```

Axon outputs JSON with AST-level chunks (accurate function boundaries, docstrings, parameter lists). The scanner uses this output instead of the regex chunker for that repo.

### Fallback

If Axon fails or is unavailable, the scanner falls back to the regex chunker automatically.

---

## Environment Variables (Alternative to config file)

If `cortex.config.json` is not present, these env vars are used:

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
| `CORTEX_HOST` | localhost | API server host |
| `CORTEX_API_KEY` | (empty) | API auth key |

---

## Build Order (35 steps for extending)

Follow this order when extending Context Cortex:

### Database changes
1. Edit `src/db/schema.sql` — add tables, columns, or indexes
2. Run `npm run reset` to apply (dev) or write a migration script (prod)

### New language support in chunker
3. Add extension to `EXT_TO_LANGUAGE` map in `src/scan/file-walker.js`
4. Add regex pattern set to `PATTERNS` in `src/scan/chunker.js`
5. Add language alias if needed (e.g. `PATTERNS.jsx = PATTERNS.javascript`)
6. Test: `node -e "import('./src/scan/chunker.js').then(m => console.log(m.chunkFile('test.rb', 'ruby', {})))"`

### New graph edge type
7. Define regex patterns in `src/graph/builder.js`
8. Add extractor function following the `extractImports` / `extractRoutes` pattern
9. Call new extractor in `processChunk()`
10. Add new `edge_type` value to `graph_edges` — no schema change needed (text column)
11. Add aggregation to `getGraphStats()` in `src/dump/claude-md.js`
12. Add display section in `generateClaudeMd()` in `src/dump/claude-md.js`

### New health check type
13. Add handler function in `src/check/snapshot.js` following `checkHttp` / `checkTcp` pattern
14. Add case to the `switch (type)` in `checkService()`
15. Document new type in `cortex.config.example.json`

### New API endpoint
16. Add route handler in `src/api/routes.js`
17. Use `asyncHandler()` wrapper for async routes
18. Use `requireAuth` middleware for protected endpoints
19. Return consistent JSON shapes

### New scan option
20. Add field to `defaultScanConfig()` in `src/config.js`
21. Document in `cortex.config.example.json`
22. Consume in `src/scan/index.js` or `src/scan/chunker.js`

### Axon integration (deeper AST analysis)
23. Implement `vendor/axon/` subprocess call in `src/scan/index.js`
24. Parse JSON output from Axon CLI
25. Map Axon's chunk format to the `code_chunks` schema
26. Handle subprocess failures with fallback to regex chunker

### CLAUDE.md customization
27. Add new query function in `src/dump/claude-md.js`
28. Call in the `Promise.all` array in `generateClaudeMd()`
29. Add markdown section building to `generateClaudeMd()`

### New script
30. Create in `scripts/` following existing patterns
31. Import `dotenv/config` at top
32. Load config with `getConfig()`
33. Call `closePool()` before `process.exit()`

### Adding a new repo
34. Add entry to `repos[]` in `cortex.config.json`
35. Run `node scripts/full-scan.js my-new-repo` to scan immediately

---

## Key Conventions

- **ES modules everywhere** (`type: module` in package.json). Use `.js` extensions in all imports.
- **Windows path safety**: Use `path.join()` everywhere. Never hardcode `/` separators.
- **No hardcoded data**: Return null/empty arrays, not fake fallback values.
- **Error logging**: Use `logError()` from `db/connection.js` for non-fatal errors (scan failures, embed failures). Don't throw — continue with other files.
- **Pool management**: Scripts must call `closePool()` before `process.exit()`.
- **Embeddings are nullable**: Always check for null embedding. Full-text search works without them.
- **content_hash deduplication**: If `content_hash` is unchanged and embedding exists, skip upsert. Saves DB writes and Ollama calls.
- **Relative paths use forward slashes**: Normalize with `.replace(/\\/g, '/')` on Windows.
- **Cron validation**: Always call `cron.validate(schedule)` before scheduling.

---

## Known Gotchas

### pgvector may not be installed
- Symptom: `runSchema()` fails with "extension vector does not exist"
- Solution: `src/db/connection.js` catches this and falls back to `TEXT` column for embedding. Install pgvector for vector search: `apt install postgresql-16-pgvector`

### IVFFlat index requires data before creation
- Symptom: `CREATE INDEX USING ivfflat` fails on empty table
- Solution: The index creation in `schema.sql` uses `IF NOT EXISTS` and will succeed on empty tables. IVFFlat needs `VACUUM ANALYZE cortex.code_chunks` after first data load for optimal performance.

### Windows glob patterns
- Symptom: Paths returned with backslashes break `relative_path` uniqueness
- Solution: `file-walker.js` normalizes all paths with `.replace(/\\/g, '/')`

### Chokidar on Windows requires polling for network drives
- Symptom: File changes on network drives not detected
- Solution: Set `usePolling: true` in the chokidar config in `server.js`

### Large repos (100k+ files)
- Symptom: Initial scan takes very long
- Solution: Increase `concurrency`, narrow `includeExtensions`, add more `ignorePatterns`

### Ollama timeout on large files
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
node scripts/reset.js --force  # skip confirmation

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

## Services

| Component | Default | Notes |
|-----------|---------|-------|
| HTTP API | :3131 | Express, configurable |
| PostgreSQL | :5432 | cortex schema |
| Ollama | :11434 | nomic-embed-text |
