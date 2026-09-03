#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function defaultRoots() {
  return [path.resolve(process.cwd(), 'worktree', 'cases')];
}

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'artifacts',
  '.next',
  '.nuxt',
  '.output',
]);

function parseArgs(argv) {
  const args = {
    query: '',
    roots: [],
    json: false,
    limit: 20,
    maxDepth: 7,
    includeTests: false,
    includeHelpers: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const readValue = () => {
      if (arg.includes('=')) return arg.slice(arg.indexOf('=') + 1);
      i += 1;
      if (i >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[i];
    };

    if (arg === '--query' || arg.startsWith('--query=')) args.query = readValue();
    else if (arg === '--roots' || arg.startsWith('--roots=')) args.roots.push(...splitRoots(readValue()));
    else if (arg === '--limit' || arg.startsWith('--limit=')) args.limit = Number(readValue()) || 20;
    else if (arg === '--max-depth' || arg.startsWith('--max-depth=')) args.maxDepth = Number(readValue()) || 7;
    else if (arg === '--json') args.json = true;
    else if (arg === '--include-tests') args.includeTests = true;
    else if (arg === '--include-helpers') args.includeHelpers = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function splitRoots(value) {
  return String(value || '')
    .split(/[,;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueExistingRoots(roots) {
  const seen = new Set();
  const out = [];
  for (const root of roots) {
    const resolved = path.resolve(root);
    if (seen.has(resolved) || !fs.existsSync(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

function walk(root, maxDepth, suffix = '.js') {
  const files = [];
  const visit = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) visit(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        files.push(full);
      }
    }
  };
  visit(root, 0);
  return files;
}

function readSmallFile(file) {
  try {
    const stat = fs.statSync(file);
    if (stat.size > 800_000) return '';
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function isExecutable(source, file) {
  if (/^#!.*\bnode\b/.test(source)) return true;
  if (/require\.main\s*===\s*module/.test(source)) return true;
  if (/process\.argv|parseArgs\s*\(|commander|yargs/.test(source)) return true;
  if (/from ['"]@playwright\/test['"]|require\(['"]@playwright\/test['"]\)|node:test/.test(source)) return true;
  if (/\.test\.js$/.test(file)) return true;
  return false;
}

function commandKind(source, file) {
  if (/\.test\.js$/.test(file) || /node:test/.test(source)) return 'node --test';
  return 'node';
}

function extractTitle(source, file) {
  const patterns = [
    /Case:\s*([^\n*]+)/,
    /Generated from case:\s*([^\n*]+)/,
    /case:\s*['"`]([^'"`]+)['"`]/i,
    /description:\s*['"`]([^'"`]+)['"`]/i,
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match && match[1]) return cleanText(match[1]);
  }
  return path.basename(file);
}

function cleanText(value) {
  return String(value || '').replace(/^\s*\*\s?/, '').trim().replace(/\s+/g, ' ');
}

function extractOptions(source) {
  return [...new Set([...source.matchAll(/--[a-zA-Z0-9][a-zA-Z0-9-]*/g)].map((m) => m[0]))].sort();
}

function extractStepTexts(source) {
  const texts = [];
  for (const match of source.matchAll(/\[\s*['"`]([^'"`]+)['"`]\s*,\s*['"`]([^'"`]+)['"`]\s*\]/g)) {
    texts.push(`${match[1]} ${match[2]}`);
    if (texts.length >= 30) break;
  }
  return texts;
}

function tokenize(value) {
  const text = String(value || '').toLowerCase();
  const tokens = text.match(/[a-z0-9_-]+|[\u4e00-\u9fff]{2,}/g) || [];
  const chinese = text.match(/[\u4e00-\u9fff]/g) || [];
  for (let i = 0; i < chinese.length - 1; i += 1) tokens.push(chinese[i] + chinese[i + 1]);
  return [...new Set(tokens.filter((token) => token.length >= 2))];
}

function scoreCandidate(candidate, query) {
  const q = String(query || '').toLowerCase().trim();
  const haystack = [
    candidate.path,
    candidate.title,
    candidate.options.join(' '),
    candidate.steps.join(' '),
    candidate.sampleText,
  ].join('\n').toLowerCase();

  let score = candidate.executable ? 20 : 0;
  if (q && haystack.includes(q)) score += 100;
  for (const token of tokenize(q)) {
    if (haystack.includes(token)) score += token.length >= 4 ? 10 : 4;
  }
  if (/case|detail|e2e|playwright|test|脚本|用例|流程/.test(haystack)) score += 5;
  if (candidate.path.includes('/worktree/')) score += 20;
  if (candidate.options.length) score += 3;
  return score;
}

function isDefaultCaseScript(file, casesRoot) {
  return path.basename(file) === 'script.js'
    && path.dirname(path.dirname(file)) === casesRoot;
}

function analyzeFile(file, query) {
  const source = readSmallFile(file);
  if (!source) return null;
  const executable = isExecutable(source, file);
  const candidate = {
    path: file,
    executable,
    commandKind: commandKind(source, file),
    title: extractTitle(source, file),
    options: extractOptions(source).slice(0, 80),
    steps: extractStepTexts(source),
    sampleText: cleanText(source.slice(0, 3000)),
  };
  candidate.score = scoreCandidate(candidate, query);
  candidate.command = `${candidate.commandKind} ${JSON.stringify(file)}`;
  return candidate;
}

function usage() {
  return `Usage:
  node discover_js_scripts.js --query "<description>" [--roots "/path/a,/path/b"] [--json]

Options:
  --query      Natural-language case description or keywords.
  --roots      Comma/semicolon-separated search roots. Defaults to cwd/worktree.
  --limit      Number of candidates to print. Default: 20.
  --max-depth  Recursive depth per root. Default: 7.
  --json       Print JSON only.
  --include-tests
              Include *.test.js files.
  --include-helpers
              Include helper/library JS files.
`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const defaultCasesRoot = defaultRoots()[0];
  const explicitRoots = uniqueExistingRoots(args.roots);
  const defaultRoot = uniqueExistingRoots([defaultCasesRoot]);
  const roots = uniqueExistingRoots([...args.roots, defaultCasesRoot]);
  const explicitFiles = explicitRoots.flatMap((root) => walk(root, args.maxDepth));
  const defaultFiles = defaultRoot
    .flatMap((root) => walk(root, args.maxDepth))
    .filter((file) => isDefaultCaseScript(file, defaultCasesRoot));
  const files = [...new Set([...explicitFiles, ...defaultFiles])];
  const candidates = files
    .filter((file) => args.includeTests || !/\.test\.js$/.test(file))
    .filter((file) => args.includeHelpers || !/(^|[-_])helpers?\.js$/.test(path.basename(file)))
    .filter((file) => args.includeHelpers || !/[\\/](?:components|shared)[\\/]/.test(file))
    .map((file) => analyzeFile(file, args.query))
    .filter(Boolean)
    .filter((candidate) => candidate.executable || candidate.score > 20)
    .sort((a, b) => b.score - a.score)
    .slice(0, args.limit);

  const output = {
    query: args.query,
    roots,
    count: candidates.length,
    candidates,
  };

  if (args.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log(`Found ${candidates.length} candidate JS scripts`);
  for (const [index, candidate] of candidates.entries()) {
    console.log('');
    console.log(`${index + 1}. score=${candidate.score} ${candidate.title}`);
    console.log(`   path: ${candidate.path}`);
    console.log(`   command: ${candidate.command}`);
    if (candidate.options.length) console.log(`   options: ${candidate.options.slice(0, 24).join(' ')}`);
    if (candidate.steps.length) console.log(`   steps: ${candidate.steps.slice(0, 6).join(' | ')}`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error('[error] ' + (error && error.message ? error.message : error));
    process.exitCode = 1;
  }
}
