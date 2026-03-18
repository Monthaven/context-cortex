# Context Cortex

Autonomous code intelligence — scans repos, builds knowledge graphs, generates `CLAUDE.md` context files for Claude Code.

## What it does

Point Context Cortex at any codebase and it will:

- Scan source files and split them into semantic chunks (functions, classes, blocks)
- Embed each chunk with Ollama (`nomic-embed-text`)
- Store everything in PostgreSQL with pgvector for full-text and vector search
- Build a knowledge graph of imports, API routes, and database table references
- Generate a `CLAUDE.md` file for each repo so Claude Code has instant context
- Monitor service health (HTTP, TCP, Docker) and snapshot results
- Watch files with chokidar for live incremental updates

## Install

```bash
git clone https://github.com/context-cortex/context-cortex
cd context-cortex
npm install
```

**Prerequisites:**
- Node.js 18+
- PostgreSQL 14+ with [pgvector](https://github.com/pgvector/pgvector)
- [Ollama](https://ollama.ai) running locally (for embeddings)

## Configure

```bash
cp cortex.config.example.json cortex.config.json
```

Edit `cortex.config.json`:

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

See `cortex.config.example.json` for the full configuration reference.

## Run

```bash
# First-time setup: creates schema, scans repos, generates CLAUDE.md
npm run setup

# Start the server (file watcher + API + cron jobs)
npm start

# Manual operations
npm run scan           # rescan all repos
npm run health         # run health checks
npm run reset          # drop and recreate schema (destructive)
```

## Architecture

```
cortex.config.json
       │
       ▼
  src/config.js ──────────────────────────────────────────┐
       │                                                    │
       ├──► src/scan/file-walker.js  (glob, language detect)│
       │           │                                        │
       │           ▼                                        │
       │    src/scan/chunker.js  (JS/TS/Python/SQL/MD)     │
       │           │                                        │
       │           ▼                                        │
       ├──► src/scan/index.js  ──► Ollama (embeddings)     │
       │           │                                        │
       │           ▼                                        │
       │    PostgreSQL: cortex.code_chunks                  │
       │           │                                        │
       ├──► src/graph/builder.js (imports, routes, SQL)     │
       │           │                                        │
       │           ▼                                        │
       │    PostgreSQL: cortex.graph_edges                  │
       │           │                                        │
       ├──► src/check/snapshot.js (HTTP/TCP/Docker)         │
       │           │                                        │
       │           ▼                                        │
       │    PostgreSQL: cortex.health_snapshots             │
       │           │                                        │
       └──► src/dump/claude-md.js  ──► CLAUDE.md           │
                                                            │
  server.js: Express API + chokidar + node-cron ───────────┘
```

## API

The HTTP API runs on `http://localhost:3131` by default.

| Endpoint | Description |
|----------|-------------|
| `GET /status` | System status |
| `GET /repos` | List configured repos |
| `GET /repos/:name/chunks` | Code chunks (filterable) |
| `GET /repos/:name/graph` | Knowledge graph edges |
| `GET /repos/:name/health` | Service health snapshots |
| `GET /search?q=term` | Full-text search across chunks |
| `POST /scan/:name` | Trigger scan |
| `POST /health/:name` | Trigger health check |
| `POST /dump/:name` | Regenerate CLAUDE.md |

## Database Schema

Six tables in the `cortex` PostgreSQL schema:

| Table | Purpose |
|-------|---------|
| `code_chunks` | Source code chunks with embeddings |
| `graph_edges` | Import/route/DB relationships |
| `health_snapshots` | Service health history |
| `errors` | Scan/embed error log |
| `scan_log` | Scan run history |
| `table_ownership` | SQL table → repo mapping |

## Axon Integration

[Axon](https://github.com/context-cortex/axon-main) is an optional Python backend for AST-level code analysis. Copy it to `vendor/axon/` and enable it per-repo:

```json
{
  "axon": {
    "enabled": true,
    "pythonBin": "python",
    "scriptPath": "./vendor/axon/src/axon/cli.py"
  }
}
```

When enabled, Axon replaces the regex chunker with accurate AST-based chunk extraction.

## License

MIT
