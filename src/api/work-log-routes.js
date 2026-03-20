/**
 * src/api/work-log-routes.js — Work tracking API for Context Cortex
 *
 * Persistent log of all work done across repos. Auto-injected into CLAUDE.md
 * so every Claude Code session starts knowing exactly what happened before.
 *
 * Endpoints:
 *   POST /work-log                   — Log a work entry
 *   GET  /work-log                   — Retrieve entries (filtered)
 *   GET  /work-log/compact           — Compressed markdown for CLAUDE.md injection
 *   POST /work-log/session-start     — Mark session boundary start
 *   POST /work-log/session-end       — Close session
 *   PATCH /work-log/:id              — Update an existing entry (status, result)
 *   POST /work-log/scan-commits      — Backfill entries from git commits
 */

import { Router } from 'express';
import { execFileSync } from 'child_process';
import { getConfig } from '../config.js';
import { query, queryOne, queryRows } from '../db/connection.js';

const router = Router();

// -- Auth -------------------------------------------------------------------

function requireAuth(req, res, next) {
  const cfg = getConfig();
  const apiKey = cfg.server?.apiKey;

  // No API key configured — open access
  if (!apiKey) return next();

  const provided = req.headers['x-api-key'] || req.query.api_key;
  if (!provided || provided !== apiKey) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Valid X-API-Key required' });
  }
  next();
}

// -- Constants --------------------------------------------------------------

const VALID_CATEGORIES = new Set([
  'build', 'fix', 'refactor', 'debug', 'deploy', 'config',
  'feature', 'test', 'error', 'change',
]);

const VALID_STATUSES = new Set(['completed', 'in_progress', 'failed', 'reverted']);

// Infer category from commit message prefix (feat/fix/chore/etc.)
function inferCategory(msg = '') {
  const m = msg.toLowerCase();
  if (m.startsWith('fix') || m.startsWith('bug') || m.includes('hotfix')) return 'fix';
  if (m.startsWith('feat') || m.startsWith('add ') || m.startsWith('new ')) return 'feature';
  if (m.startsWith('refactor') || m.startsWith('rework')) return 'refactor';
  if (m.startsWith('test') || m.startsWith('spec')) return 'test';
  if (m.startsWith('chore') || m.startsWith('config')) return 'config';
  if (m.startsWith('deploy') || m.startsWith('release')) return 'deploy';
  if (m.startsWith('debug')) return 'debug';
  if (m.startsWith('build') || m.startsWith('ci')) return 'build';
  return 'build';
}

// -- POST /work-log ---------------------------------------------------------

router.post('/work-log', requireAuth, async (req, res) => {
  try {
    const {
      repo, session_id, category, summary, details,
      files_touched = [], endpoints_affected = [], tables_affected = [],
      status = 'completed', result, commit_hash, duration_minutes, tags = [],
    } = req.body || {};

    if (!repo) return res.status(400).json({ success: false, error: 'repo is required' });
    if (!summary) return res.status(400).json({ success: false, error: 'summary is required' });

    const cat = VALID_CATEGORIES.has(category) ? category : 'build';
    const st  = VALID_STATUSES.has(status) ? status : 'completed';

    const row = await queryOne(`
      INSERT INTO cortex.work_log
        (repo, session_id, category, summary, details,
         files_touched, endpoints_affected, tables_affected,
         status, result, commit_hash, duration_minutes, tags)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (commit_hash) WHERE commit_hash IS NOT NULL DO NOTHING
      RETURNING id, occurred_at
    `, [
      repo, session_id || null, cat, summary, details || null,
      files_touched, endpoints_affected, tables_affected,
      st, result || null, commit_hash || null,
      duration_minutes != null ? parseInt(duration_minutes) : null,
      tags,
    ]);

    res.json({ success: true, id: row?.id, occurred_at: row?.occurred_at });
  } catch (err) {
    console.error('[cortex:work-log] POST error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// -- GET /work-log ----------------------------------------------------------

router.get('/work-log', requireAuth, async (req, res) => {
  try {
    const { repo, limit = 20, category, status, since, session_id } = req.query;
    const lim = Math.min(parseInt(limit) || 20, 200);

    const conditions = [];
    const params = [];
    let idx = 0;

    if (repo)       { params.push(repo);       conditions.push(`repo = $${++idx}`); }
    if (category)   { params.push(category);   conditions.push(`category = $${++idx}`); }
    if (status)     { params.push(status);     conditions.push(`status = $${++idx}`); }
    if (session_id) { params.push(session_id); conditions.push(`session_id = $${++idx}`); }

    // since: e.g. "24h", "7d", "2026-03-18"
    if (since) {
      if (/^\d+h$/.test(since)) {
        params.push(`${parseInt(since)} hours`);
        conditions.push(`occurred_at > NOW() - $${++idx}::interval`);
      } else if (/^\d+d$/.test(since)) {
        params.push(`${parseInt(since)} days`);
        conditions.push(`occurred_at > NOW() - $${++idx}::interval`);
      } else {
        params.push(since);
        conditions.push(`occurred_at > $${++idx}::timestamptz`);
      }
    } else {
      conditions.push(`occurred_at > NOW() - INTERVAL '7 days'`);
    }

    const where = conditions.length > 0 ? conditions.join(' AND ') : '1=1';
    params.push(lim);

    const rows = await queryRows(`
      SELECT id, repo, session_id, occurred_at, category, summary, details,
             files_touched, endpoints_affected, tables_affected,
             status, result, commit_hash, duration_minutes, tags
      FROM cortex.work_log
      WHERE ${where}
      ORDER BY occurred_at DESC
      LIMIT $${++idx}
    `, params);

    res.json({ success: true, entries: rows, count: rows.length });
  } catch (err) {
    console.error('[cortex:work-log] GET error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// -- GET /work-log/compact --------------------------------------------------

router.get('/work-log/compact', requireAuth, async (req, res) => {
  try {
    const { repo, days = 7 } = req.query;
    const dayCount = Math.min(parseInt(days) || 7, 30);

    const conditions = [`occurred_at > NOW() - $1::interval`];
    const params = [`${dayCount} days`];
    let idx = 1;

    if (repo) {
      params.push(repo);
      conditions.push(`repo = $${++idx}`);
    }

    const where = conditions.join(' AND ');
    const entries = await queryRows(`
      SELECT repo, session_id, occurred_at, category, summary,
             status, result, commit_hash, files_touched, tags
      FROM cortex.work_log
      WHERE ${where}
      ORDER BY occurred_at DESC
      LIMIT 200
    `, params);

    // In-progress entries (always shown, no time filter)
    const inProgress = await queryRows(
      `SELECT id, repo, session_id, occurred_at, category, summary, result, tags
       FROM cortex.work_log WHERE status = 'in_progress' ORDER BY occurred_at DESC LIMIT 20`
    );

    if (entries.length === 0 && inProgress.length === 0) {
      return res.json({
        success: true,
        markdown: '## Recent Work\n\n_No work logged yet. Use POST /work-log to start tracking._\n',
        lineCount: 3,
      });
    }

    // Group completed entries by date
    const byDate = {};
    const now = new Date();
    const todayStr    = now.toISOString().slice(0, 10);
    const yesterdayStr = new Date(now - 86400000).toISOString().slice(0, 10);

    for (const e of entries) {
      if (e.status === 'in_progress') continue;
      const d = new Date(e.occurred_at).toISOString().slice(0, 10);
      if (!byDate[d]) byDate[d] = {};
      if (!byDate[d][e.repo]) byDate[d][e.repo] = [];
      byDate[d][e.repo].push(e);
    }

    // Build markdown
    const lines = [`## Recent Work (last ${dayCount} days)\n`];
    const MAX_LINES = 50;

    const sortedDates = Object.keys(byDate).sort().reverse();
    for (const date of sortedDates) {
      if (lines.length >= MAX_LINES - 5) break;

      const label = date === todayStr
        ? `### ${date} (today)`
        : date === yesterdayStr
          ? `### ${date} (yesterday)`
          : `### ${date}`;
      lines.push(label);

      for (const [repoName, repoEntries] of Object.entries(byDate[date])) {
        if (lines.length >= MAX_LINES - 3) break;
        lines.push(`**${repoName}:**`);
        for (const e of repoEntries) {
          if (lines.length >= MAX_LINES - 2) break;
          const hash = e.commit_hash ? ` (${e.commit_hash.slice(0, 7)})` : '';
          const outcome = e.result ? ` → ${e.result}` : '';
          lines.push(`- [${e.category}] ${e.summary}${outcome}${hash}`);
        }
      }
      lines.push('');
    }

    // In-progress section
    if (inProgress.length > 0) {
      lines.push('### In Progress');
      for (const e of inProgress.slice(0, 8)) {
        const detail = e.result ? ` — ${e.result}` : '';
        lines.push(`- [${e.category}/${e.repo}] ${e.summary}${detail}`);
      }
    }

    const markdown = lines.join('\n');
    res.json({ success: true, markdown, lineCount: lines.length, entryCount: entries.length });
  } catch (err) {
    console.error('[cortex:work-log] compact error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// -- POST /work-log/session-start -------------------------------------------

router.post('/work-log/session-start', requireAuth, async (req, res) => {
  try {
    const { repo, session_id, summary } = req.body || {};
    if (!repo) return res.status(400).json({ success: false, error: 'repo is required' });
    if (!summary) return res.status(400).json({ success: false, error: 'summary is required' });

    // Auto-generate session_id if not provided
    const sid = session_id || `${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`;

    const row = await queryOne(`
      INSERT INTO cortex.work_log
        (repo, session_id, category, summary, status, tags)
      VALUES ($1, $2, 'build', $3, 'in_progress', '{session}')
      RETURNING id
    `, [repo, sid, `SESSION START: ${summary}`]);

    res.json({ success: true, session_id: sid, id: row?.id });
  } catch (err) {
    console.error('[cortex:work-log] session-start error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// -- POST /work-log/session-end ---------------------------------------------

router.post('/work-log/session-end', requireAuth, async (req, res) => {
  try {
    const { session_id, summary, result } = req.body || {};
    if (!session_id) return res.status(400).json({ success: false, error: 'session_id is required' });

    await query(`
      UPDATE cortex.work_log
      SET status = 'completed',
          result = $1,
          summary = $2
      WHERE session_id = $3 AND status = 'in_progress'
    `, [
      result || null,
      summary ? `SESSION END: ${summary}` : 'Session completed',
      session_id,
    ]);

    res.json({ success: true, session_id });
  } catch (err) {
    console.error('[cortex:work-log] session-end error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// -- PATCH /work-log/:id ----------------------------------------------------

router.patch('/work-log/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: 'Invalid id' });

    const { status, result, details, tags } = req.body || {};
    const sets = [];
    const params = [];
    let idx = 0;

    if (status  && VALID_STATUSES.has(status))  { params.push(status);  sets.push(`status = $${++idx}`); }
    if (result  !== undefined)                   { params.push(result);  sets.push(`result = $${++idx}`); }
    if (details !== undefined)                   { params.push(details); sets.push(`details = $${++idx}`); }
    if (tags    !== undefined)                   { params.push(tags);    sets.push(`tags = $${++idx}`); }

    if (sets.length === 0) {
      return res.status(400).json({ success: false, error: 'No valid fields to update' });
    }

    params.push(id);
    await query(`UPDATE cortex.work_log SET ${sets.join(', ')} WHERE id = $${++idx}`, params);
    res.json({ success: true });
  } catch (err) {
    console.error('[cortex:work-log] PATCH error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// -- POST /work-log/scan-commits --------------------------------------------
// Backfill work_log entries from recent git commits across all configured repos.

router.post('/work-log/scan-commits', requireAuth, async (req, res) => {
  try {
    const { repo: repoFilter, since = '24h' } = req.query;
    const config = getConfig();

    // Parse since into git --since format
    let gitSince = '24 hours ago';
    if (/^\d+h$/.test(since)) gitSince = `${parseInt(since)} hours ago`;
    else if (/^\d+d$/.test(since)) gitSince = `${parseInt(since)} days ago`;
    else gitSince = since;

    const repos = repoFilter
      ? config.repos.filter(r => r.name === repoFilter)
      : config.repos;

    const logged = [];
    const errors = [];

    for (const repo of repos) {
      try {
        // Get recent commits: hash|subject|author-date
        const logOut = execFileSync('git', [
          '-C', repo.path,
          'log',
          `--since=${gitSince}`,
          '--pretty=format:%H|%s|%ai',
          '--no-merges',
        ], { encoding: 'utf8', timeout: 15000, windowsHide: true }).trim();

        if (!logOut) continue;

        for (const line of logOut.split('\n')) {
          const [hash, subject, date] = line.split('|');
          if (!hash || !subject) continue;

          // Get changed files
          let filesChanged = [];
          try {
            const diffOut = execFileSync('git', [
              '-C', repo.path,
              'diff-tree', '--no-commit-id', '-r', '--name-only', hash,
            ], { encoding: 'utf8', timeout: 10000, windowsHide: true }).trim();
            filesChanged = diffOut.split('\n').filter(Boolean).slice(0, 30);
          } catch {}

          const cat = inferCategory(subject);
          await query(`
            INSERT INTO cortex.work_log
              (repo, occurred_at, category, summary, files_touched, status, commit_hash, tags)
            VALUES ($1, $2, $3, $4, $5, 'completed', $6, '{git-auto}')
            ON CONFLICT (commit_hash) WHERE commit_hash IS NOT NULL DO NOTHING
          `, [repo.name, date, cat, subject.slice(0, 500), filesChanged, hash]);

          logged.push({ repo: repo.name, commit: hash.slice(0, 7), summary: subject.slice(0, 80) });
        }
      } catch (err) {
        errors.push({ repo: repo.name, error: err.message });
      }
    }

    res.json({ success: true, logged: logged.length, entries: logged, errors });
  } catch (err) {
    console.error('[cortex:work-log] scan-commits error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;

// -- Exported helpers for internal auto-logging -----------------------------

/**
 * Log a work entry from internal cortex modules (scan, health, embed).
 * Fire-and-forget — never throws.
 */
export async function logWork(entry) {
  try {
    const {
      repo = 'context-cortex',
      category = 'build',
      summary,
      details,
      files_touched = [],
      endpoints_affected = [],
      tables_affected = [],
      status = 'completed',
      result,
      commit_hash,
      tags = [],
    } = entry;

    if (!summary) return;

    await query(`
      INSERT INTO cortex.work_log
        (repo, category, summary, details,
         files_touched, endpoints_affected, tables_affected,
         status, result, commit_hash, tags)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (commit_hash) WHERE commit_hash IS NOT NULL DO NOTHING
    `, [
      repo, category, summary, details || null,
      files_touched, endpoints_affected, tables_affected,
      status, result || null, commit_hash || null, tags,
    ]);
  } catch {
    // Fire-and-forget — never throws
  }
}

/**
 * Update the most recent in_progress work entry matching a tag.
 * Used to close out ongoing entries (e.g. embedding progress -> completed).
 */
export async function updateWorkEntry(matchTag, updates) {
  try {
    const { status, result, summary } = updates;
    const sets = [];
    const params = [];
    let idx = 0;

    if (status)  { params.push(status);  sets.push(`status = $${++idx}`); }
    if (result)  { params.push(result);  sets.push(`result = $${++idx}`); }
    if (summary) { params.push(summary); sets.push(`summary = $${++idx}`); }
    if (sets.length === 0) return;

    params.push(matchTag);
    await query(`
      UPDATE cortex.work_log
      SET ${sets.join(', ')}
      WHERE id = (
        SELECT id FROM cortex.work_log
        WHERE $${++idx} = ANY(tags)
        ORDER BY occurred_at DESC
        LIMIT 1
      )
    `, params);
  } catch {
    // Fire-and-forget — never throws
  }
}
