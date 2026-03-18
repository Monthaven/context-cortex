/**
 * src/check/snapshot.js
 * Health checker for services declared in repo configs.
 *
 * Supports three check types:
 *   http   — GET request, checks response status
 *   tcp    — TCP connection test (net.createConnection)
 *   docker — docker inspect to check if container is running
 *
 * Results are stored in cortex.health_snapshots.
 */

import net from 'net';
import { query, logError } from '../db/connection.js';
import { getConfig } from '../config.js';

// ---------------------------------------------------------------------------
// HTTP check
// ---------------------------------------------------------------------------

async function checkHttp(serviceName, serviceConfig, timeoutMs) {
  const start = Date.now();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(serviceConfig.url, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });

    clearTimeout(timer);

    const latency = Date.now() - start;
    const expected = serviceConfig.expectedStatus || 200;
    const ok = res.status === expected;

    return {
      status: ok ? 'ok' : 'degraded',
      latencyMs: latency,
      statusCode: res.status,
      errorMessage: ok ? null : `Expected HTTP ${expected}, got ${res.status}`,
    };
  } catch (err) {
    const latency = Date.now() - start;
    const isTimeout = err.name === 'AbortError' || err.code === 'ECONNABORTED';
    return {
      status: 'down',
      latencyMs: latency,
      statusCode: null,
      errorMessage: isTimeout ? `Timeout after ${timeoutMs}ms` : err.message,
    };
  }
}

// ---------------------------------------------------------------------------
// TCP check
// ---------------------------------------------------------------------------

function checkTcp(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    let settled = false;

    const finish = (status, error = null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({
        status,
        latencyMs: Date.now() - start,
        statusCode: null,
        errorMessage: error,
      });
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish('ok'));
    socket.once('timeout', () => finish('down', `Timeout after ${timeoutMs}ms`));
    socket.once('error', (err) => finish('down', err.message));

    socket.connect(port, host);
  });
}

// ---------------------------------------------------------------------------
// Docker check
// ---------------------------------------------------------------------------

async function checkDocker(containerName, timeoutMs) {
  const start = Date.now();

  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const { stdout } = await execFileAsync(
      'docker',
      ['inspect', '--format', '{{.State.Status}}', containerName],
      { signal: controller.signal, timeout: timeoutMs }
    );

    clearTimeout(timer);

    const state = stdout.trim().toLowerCase();
    const latency = Date.now() - start;

    return {
      status: state === 'running' ? 'ok' : 'degraded',
      latencyMs: latency,
      statusCode: null,
      errorMessage: state !== 'running' ? `Container state: ${state}` : null,
    };
  } catch (err) {
    return {
      status: 'down',
      latencyMs: Date.now() - start,
      statusCode: null,
      errorMessage: err.message,
    };
  }
}

// ---------------------------------------------------------------------------
// Single service check (with retries)
// ---------------------------------------------------------------------------

async function checkService(serviceName, serviceConfig, healthConfig) {
  const timeoutMs = healthConfig.timeoutMs || 5000;
  const retries = healthConfig.retries || 2;
  const type = serviceConfig.type || 'tcp';

  let lastResult;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, 500 * attempt)); // backoff
    }

    switch (type) {
      case 'http':
        lastResult = await checkHttp(serviceName, serviceConfig, timeoutMs);
        break;

      case 'tcp':
        lastResult = await checkTcp(
          serviceConfig.host || 'localhost',
          serviceConfig.port,
          timeoutMs
        );
        break;

      case 'docker':
        lastResult = await checkDocker(serviceConfig.container || serviceName, timeoutMs);
        break;

      default:
        lastResult = {
          status: 'unknown',
          latencyMs: 0,
          statusCode: null,
          errorMessage: `Unknown check type: ${type}`,
        };
    }

    if (lastResult.status === 'ok') break; // Success — stop retrying
  }

  return lastResult;
}

// ---------------------------------------------------------------------------
// Store snapshot
// ---------------------------------------------------------------------------

async function storeSnapshot(repoName, serviceName, serviceType, result) {
  await query(
    `INSERT INTO cortex.health_snapshots
       (repo_name, service_name, service_type, status, latency_ms, status_code, error_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      repoName,
      serviceName,
      serviceType,
      result.status,
      result.latencyMs,
      result.statusCode,
      result.errorMessage,
    ]
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run health checks for all services in a repo config.
 * Stores results to cortex.health_snapshots.
 *
 * @param {object} repoConfig - Merged repo config
 * @returns {Promise<Array<{serviceName, status, latencyMs, error}>>}
 */
export async function runHealthCheck(repoConfig) {
  const cfg = getConfig();
  const { name: repoName, services = {} } = repoConfig;
  const healthConfig = cfg.health;

  const serviceEntries = Object.entries(services);

  if (serviceEntries.length === 0) {
    console.log(`[cortex:health] ${repoName}: no services configured`);
    return [];
  }

  console.log(`[cortex:health] ${repoName}: checking ${serviceEntries.length} services...`);

  const results = await Promise.allSettled(
    serviceEntries.map(async ([serviceName, serviceConfig]) => {
      const result = await checkService(serviceName, serviceConfig, healthConfig);
      await storeSnapshot(repoName, serviceName, serviceConfig.type || 'tcp', result);

      const statusIcon = result.status === 'ok' ? '✓' : result.status === 'degraded' ? '⚠' : '✗';
      console.log(
        `[cortex:health] ${repoName}/${serviceName}: ${statusIcon} ${result.status} ` +
        `(${result.latencyMs}ms)${result.errorMessage ? ' — ' + result.errorMessage : ''}`
      );

      return { serviceName, ...result };
    })
  );

  const checks = results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    const serviceName = serviceEntries[i][0];
    console.error(`[cortex:health] ${repoName}/${serviceName}: check threw: ${r.reason?.message}`);
    return { serviceName, status: 'unknown', latencyMs: 0, errorMessage: r.reason?.message };
  });

  const ok = checks.filter(c => c.status === 'ok').length;
  console.log(`[cortex:health] ${repoName}: ${ok}/${checks.length} services healthy`);

  return checks;
}

/**
 * Get the latest health snapshot for each service in a repo.
 */
export async function getLatestHealth(repoName) {
  const { queryRows } = await import('../db/connection.js');

  return queryRows(
    `SELECT DISTINCT ON (service_name)
       service_name, service_type, status, latency_ms, error_message, checked_at
     FROM cortex.health_snapshots
     WHERE repo_name = $1
     ORDER BY service_name, checked_at DESC`,
    [repoName]
  );
}

/**
 * Get health history for a service (last N checks).
 */
export async function getHealthHistory(repoName, serviceName, limit = 20) {
  const { queryRows } = await import('../db/connection.js');

  return queryRows(
    `SELECT status, latency_ms, error_message, checked_at
     FROM cortex.health_snapshots
     WHERE repo_name = $1 AND service_name = $2
     ORDER BY checked_at DESC
     LIMIT $3`,
    [repoName, serviceName, limit]
  );
}
