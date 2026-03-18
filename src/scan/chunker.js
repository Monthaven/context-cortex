/**
 * src/scan/chunker.js
 * Splits source files into semantic chunks.
 *
 * Strategy by language:
 *   JavaScript/TypeScript: splits on function/class/const/export declarations
 *   Python:                splits on def/class definitions
 *   SQL:                   splits on CREATE/INSERT/SELECT statements
 *   Markdown:              splits on heading sections (##, ###)
 *   Others:                fixed line count (chunkSizeLines with overlap)
 *
 * Each chunk: { name, type, content, startLine, endLine, language }
 */

import { readFileSync } from 'fs';

// ---------------------------------------------------------------------------
// Regex patterns for language-aware splitting
// ---------------------------------------------------------------------------

const PATTERNS = {
  javascript: {
    // Named function declarations, arrow functions assigned to const/let/var,
    // class declarations, export default function, async functions
    declarations: [
      /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/,
      /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function|\(.*?\)\s*=>|\w+\s*=>)/,
      /^(?:export\s+)?class\s+(\w+)/,
      /^(?:export\s+default\s+)?(?:async\s+)?function\s*\(/,
      /^(?:export\s+)?const\s+(\w+)\s*=\s*\{/,  // object exports
    ],
    type: (line) => {
      if (/^(?:export\s+)?class\b/.test(line)) return 'class';
      if (/\bfunction\b/.test(line)) return 'function';
      if (/^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*\{/.test(line)) return 'object';
      return 'const';
    },
  },

  typescript: {
    declarations: [
      /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[<(]/,
      /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?\s*=\s*(?:async\s+)?(?:function|\(.*?\)\s*=>|\w+\s*=>)/,
      /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/,
      /^(?:export\s+)?interface\s+(\w+)/,
      /^(?:export\s+)?type\s+(\w+)\s*=/,
      /^(?:export\s+)?enum\s+(\w+)/,
    ],
    type: (line) => {
      if (/\binterface\b/.test(line)) return 'interface';
      if (/\benum\b/.test(line)) return 'enum';
      if (/\btype\s+\w+\s*=/.test(line)) return 'type';
      if (/\bclass\b/.test(line)) return 'class';
      if (/\bfunction\b/.test(line)) return 'function';
      return 'const';
    },
  },

  python: {
    declarations: [
      /^(?:async\s+)?def\s+(\w+)\s*\(/,
      /^class\s+(\w+)/,
    ],
    type: (line) => {
      if (/^class\s/.test(line)) return 'class';
      return 'function';
    },
  },

  sql: {
    declarations: [
      /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|FUNCTION|PROCEDURE|INDEX|TRIGGER|SCHEMA)\s+(?:\w+\.)?(\w+)/i,
      /^ALTER\s+TABLE\s+(?:\w+\.)?(\w+)/i,
      /^INSERT\s+INTO\s+(?:\w+\.)?(\w+)/i,
      /^SELECT\b/i,
      /^UPDATE\s+(?:\w+\.)?(\w+)/i,
      /^DELETE\s+FROM\s+(?:\w+\.)?(\w+)/i,
      /^DROP\s+(?:TABLE|VIEW|INDEX|FUNCTION)\s+(?:IF\s+EXISTS\s+)?(?:\w+\.)?(\w+)/i,
    ],
    type: (line) => {
      const up = line.trim().toUpperCase();
      if (up.startsWith('CREATE')) return 'ddl';
      if (up.startsWith('ALTER')) return 'ddl';
      if (up.startsWith('DROP')) return 'ddl';
      if (up.startsWith('INSERT')) return 'dml';
      if (up.startsWith('UPDATE')) return 'dml';
      if (up.startsWith('DELETE')) return 'dml';
      return 'query';
    },
  },

  markdown: {
    declarations: [
      /^#{1,4}\s+(.+)/,
    ],
    type: () => 'section',
  },
};

// Languages that get JS-style analysis
PATTERNS.jsx = PATTERNS.javascript;
PATTERNS.tsx = PATTERNS.typescript;

// ---------------------------------------------------------------------------
// Name extractor
// ---------------------------------------------------------------------------

function extractName(line, patterns) {
  for (const re of patterns.declarations) {
    const m = line.match(re);
    if (m) {
      // Group 1 is the name if captured, else use a truncated line
      return m[1] || line.trim().slice(0, 60);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Language-aware chunker
// ---------------------------------------------------------------------------

function chunkByDeclarations(lines, language, langPatterns) {
  const chunks = [];
  let currentStart = 0;
  let currentName = `${language}_top_level`;
  let currentType = 'block';

  const flush = (endLine) => {
    if (endLine <= currentStart) return;
    const content = lines.slice(currentStart, endLine).join('\n').trim();
    if (content.length < 10) return; // Skip near-empty chunks
    chunks.push({
      name: currentName,
      type: currentType,
      content,
      startLine: currentStart + 1,
      endLine,
      language,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip blank lines and pure comment lines at declaration detection
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) {
      continue;
    }

    const name = extractName(line, langPatterns);
    if (name !== null) {
      flush(i);
      currentStart = i;
      currentName = name;
      currentType = langPatterns.type(line);
    }
  }

  flush(lines.length);
  return chunks;
}

// ---------------------------------------------------------------------------
// Fixed-size chunker (fallback for unknown languages)
// ---------------------------------------------------------------------------

function chunkByLines(lines, language, chunkSize, overlap) {
  const chunks = [];
  let chunkIndex = 0;

  for (let i = 0; i < lines.length; i += chunkSize - overlap) {
    const end = Math.min(i + chunkSize, lines.length);
    const content = lines.slice(i, end).join('\n').trim();

    if (content.length > 10) {
      chunkIndex++;
      chunks.push({
        name: `chunk_${chunkIndex}`,
        type: 'block',
        content,
        startLine: i + 1,
        endLine: end,
        language,
      });
    }

    if (end === lines.length) break;
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Whole-file chunk (for small files)
// ---------------------------------------------------------------------------

function chunkWholeFile(lines, language, filePath) {
  const content = lines.join('\n').trim();
  if (!content) return [];
  return [{
    name: filePath.split('/').pop() || 'file',
    type: 'file',
    content,
    startLine: 1,
    endLine: lines.length,
    language,
  }];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Split a file into semantic chunks.
 *
 * @param {string} filePath - Absolute path to file
 * @param {string} language - Detected language
 * @param {object} scanConfig - scan config (chunkSizeLines, chunkOverlapLines)
 * @returns {Array<{name, type, content, startLine, endLine, language}>}
 */
export function chunkFile(filePath, language, scanConfig = {}) {
  const chunkSize = scanConfig.chunkSizeLines || 80;
  const overlap = scanConfig.chunkOverlapLines || 5;

  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    console.warn(`[cortex:chunker] Cannot read ${filePath}: ${err.message}`);
    return [];
  }

  const lines = raw.split('\n');

  // Very small files — return as single chunk
  if (lines.length <= chunkSize) {
    return chunkWholeFile(lines, language, filePath);
  }

  const langPatterns = PATTERNS[language];
  if (langPatterns) {
    const chunks = chunkByDeclarations(lines, language, langPatterns);
    if (chunks.length > 0) return chunks;
    // Fall through if no declarations found
  }

  // Fixed-size fallback
  return chunkByLines(lines, language, chunkSize, overlap);
}

/**
 * Estimate token count for a string (rough: chars / 4).
 */
export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}
