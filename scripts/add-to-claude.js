#!/usr/bin/env node

/**
 * scripts/add-to-claude.js — Auto-configure Claude Code MCP
 *
 * Creates or updates .mcp.json in a target project to wire up
 * context-cortex as an MCP server for Claude Code.
 *
 * Usage:
 *   node scripts/add-to-claude.js                    # uses first repo in config
 *   node scripts/add-to-claude.js /path/to/project   # explicit target
 *   npm run add-to-claude -- /path/to/project
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CONFIG_PATH = join(ROOT, 'cortex.config.json');
const MCP_SERVER_PATH = join(ROOT, 'mcp-server.js');

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  console.log('');
  console.log('  Context Cortex — Claude Code MCP Setup');
  console.log('  =======================================');
  console.log('');

  // 1. Read cortex.config.json
  if (!existsSync(CONFIG_PATH)) {
    console.error('  Error: cortex.config.json not found.');
    console.error('  Run "npm run init" first to generate configuration.');
    process.exit(1);
  }

  let config;
  try {
    config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (err) {
    console.error(`  Error reading config: ${err.message}`);
    process.exit(1);
  }

  // 2. Determine target project path
  const explicitPath = process.argv[2];
  let targetPath;

  if (explicitPath) {
    targetPath = resolve(explicitPath);
  } else if (config.repos && config.repos.length > 0) {
    targetPath = resolve(config.repos[0].path);
  } else {
    console.error('  Error: No target path provided and no repos configured.');
    console.error('  Usage: npm run add-to-claude -- /path/to/project');
    process.exit(1);
  }

  if (!existsSync(targetPath)) {
    console.error(`  Error: Target path does not exist: ${targetPath}`);
    process.exit(1);
  }

  // 3. Build the MCP server entry
  const mcpServerAbsPath = resolve(MCP_SERVER_PATH).replace(/\\/g, '/');
  const configAbsPath = resolve(CONFIG_PATH).replace(/\\/g, '/');

  const cortexEntry = {
    command: 'node',
    args: [mcpServerAbsPath],
    env: {
      CORTEX_CONFIG: configAbsPath,
    },
  };

  // 4. Create or merge .mcp.json
  const mcpJsonPath = join(targetPath, '.mcp.json');
  let mcpConfig = { mcpServers: {} };

  if (existsSync(mcpJsonPath)) {
    try {
      const existing = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
      if (existing && typeof existing === 'object') {
        mcpConfig = existing;
        if (!mcpConfig.mcpServers || typeof mcpConfig.mcpServers !== 'object') {
          mcpConfig.mcpServers = {};
        }
      }
    } catch (err) {
      console.warn(`  Warning: Could not parse existing .mcp.json, will overwrite: ${err.message}`);
      mcpConfig = { mcpServers: {} };
    }

    if (mcpConfig.mcpServers['context-cortex']) {
      console.log('  Updating existing context-cortex entry in .mcp.json');
    } else {
      console.log('  Adding context-cortex to existing .mcp.json (other servers preserved)');
    }
  } else {
    console.log('  Creating new .mcp.json');
  }

  mcpConfig.mcpServers['context-cortex'] = cortexEntry;

  // 5. Write .mcp.json
  writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + '\n', 'utf-8');

  // 6. Print success
  console.log('');
  console.log(`  Written: ${mcpJsonPath}`);
  console.log('');
  console.log('  MCP server config:');
  console.log(`    command:       node`);
  console.log(`    mcp-server.js: ${mcpServerAbsPath}`);
  console.log(`    config:        ${configAbsPath}`);
  console.log('');
  console.log('  Next steps:');
  console.log('    1. Restart Claude Code to activate the MCP connection');
  console.log('    2. Verify by asking Claude to run cortex_system_status');
  console.log('');
}

main();
