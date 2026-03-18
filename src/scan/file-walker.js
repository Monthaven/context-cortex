/**
 * src/scan/file-walker.js
 * Walks a repository using glob patterns from config.
 * Returns an array of file descriptors with path, size, mtime, and detected language.
 */

import { glob } from 'glob';
import { statSync } from 'fs';
import { join, relative, extname, basename } from 'path';

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

const EXT_TO_LANGUAGE = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.py': 'python',
  '.go': 'go',
  '.rb': 'ruby',
  '.java': 'java',
  '.rs': 'rust',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.c': 'c',
  '.h': 'c',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.php': 'php',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.sql': 'sql',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.fish': 'shell',
  '.ps1': 'powershell',
  '.tf': 'terraform',
  '.hcl': 'hcl',
  '.dockerfile': 'dockerfile',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.proto': 'protobuf',
  '.vue': 'vue',
  '.svelte': 'svelte',
};

/**
 * Detects language from file extension.
 * Falls back to basename checks for files like "Dockerfile".
 */
export function detectLanguage(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (EXT_TO_LANGUAGE[ext]) return EXT_TO_LANGUAGE[ext];

  // Basename checks for extensionless files
  const base = basename(filePath).toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  if (base === 'makefile' || base === 'gnumakefile') return 'makefile';
  if (base === 'gemfile' || base === 'rakefile') return 'ruby';
  if (base === 'procfile') return 'text';

  return 'unknown';
}

// ---------------------------------------------------------------------------
// Build glob patterns
// ---------------------------------------------------------------------------

function buildPatterns(repoConfig) {
  const { scan } = repoConfig;
  const exts = scan.includeExtensions || [];

  if (exts.length === 0) {
    return ['**/*'];
  }

  // Single pattern with brace expansion: **/*.{js,ts,py,...}
  // Glob v11 supports brace expansion natively
  const extList = exts.map(e => e.replace(/^\./, '')).join(',');
  return [`**/*.{${extList}}`];
}

function buildIgnorePatterns(repoConfig) {
  const base = repoConfig.scan?.ignorePatterns || [];
  return base;
}

// ---------------------------------------------------------------------------
// Main walker
// ---------------------------------------------------------------------------

/**
 * Walk a repository and return all matching files.
 *
 * @param {object} repoConfig - Merged repo config from getConfig()
 * @returns {Promise<Array<{
 *   path: string,
 *   relativePath: string,
 *   size: number,
 *   mtime: Date,
 *   language: string
 * }>>}
 */
export async function walkRepo(repoConfig) {
  const { path: repoPath, name } = repoConfig;
  const patterns = buildPatterns(repoConfig);
  const ignore = buildIgnorePatterns(repoConfig);

  const files = [];

  for (const pattern of patterns) {
    const matches = await glob(pattern, {
      cwd: repoPath,
      ignore,
      absolute: false,
      nodir: true,
      dot: false,
      follow: false,
      // Windows: normalize separators
      posix: false,
    });

    for (const rel of matches) {
      const absPath = join(repoPath, rel);

      let stat;
      try {
        stat = statSync(absPath);
      } catch {
        // File may have been deleted between glob and stat
        continue;
      }

      // Skip symlinks, directories
      if (!stat.isFile()) continue;

      // Skip empty files
      if (stat.size === 0) continue;

      // Skip very large files (>1MB) — likely generated or binary
      if (stat.size > 1_000_000) continue;

      const language = detectLanguage(absPath);

      files.push({
        path: absPath,
        relativePath: rel.replace(/\\/g, '/'), // normalize to forward slashes
        size: stat.size,
        mtime: stat.mtime,
        language,
      });
    }
  }

  // Sort by relative path for deterministic output
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  console.log(`[cortex:walker] ${name}: found ${files.length} files`);
  return files;
}

/**
 * Walk a single file (for incremental / chokidar updates).
 */
export async function walkFile(repoConfig, absolutePath) {
  const { path: repoPath } = repoConfig;

  let stat;
  try {
    stat = statSync(absolutePath);
  } catch {
    return null; // File deleted
  }

  if (!stat.isFile() || stat.size === 0 || stat.size > 1_000_000) return null;

  const rel = relative(repoPath, absolutePath).replace(/\\/g, '/');
  const language = detectLanguage(absolutePath);

  return {
    path: absolutePath,
    relativePath: rel,
    size: stat.size,
    mtime: stat.mtime,
    language,
  };
}
