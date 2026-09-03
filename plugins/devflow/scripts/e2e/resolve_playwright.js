#!/usr/bin/env node

function loadPlaywrightRuntime(options = {}) {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const env = options.env || process.env;
  const includeDefaults = options.includeDefaults !== false;
  const tried = [];
  const candidates = [];
  const seen = new Set();

  function add(candidate) {
    if (!candidate) return;
    const value = String(candidate).trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    candidates.push(value);
  }

  function addRoot(root) {
    if (!root) return;
    const resolved = path.resolve(root);
    add(resolved);
    add(path.join(resolved, 'playwright'));
    add(path.join(resolved, '@playwright', 'test'));
    add(path.join(resolved, 'playwright-core'));
    add(path.join(resolved, '@playwright', 'cli', 'node_modules', 'playwright'));
  }

  function addAncestorNodeModules(start) {
    if (!start) return;
    let current = path.resolve(start);
    while (true) {
      addRoot(path.join(current, 'node_modules'));
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  for (const candidate of options.candidatePaths || []) add(candidate);
  for (const candidate of String(env.E2E_PLAYWRIGHT_PATH || '').split(path.delimiter)) add(candidate);
  for (const root of String(env.NODE_PATH || '').split(path.delimiter)) addRoot(root);

  if (includeDefaults) {
    add('playwright');
    add('@playwright/test');
    add('playwright-core');
    addAncestorNodeModules(options.cwd || process.cwd());
    addAncestorNodeModules(options.scriptDir || __dirname);
    try {
      addRoot(execFileSync('npm', ['root', '-g'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      }).trim());
    } catch {}
    addRoot('/opt/homebrew/lib/node_modules');
    addRoot('/usr/local/lib/node_modules');
    addRoot(path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules'));
    addRoot(path.join(os.homedir(), '.npm-global', 'lib', 'node_modules'));
  }

  for (const candidate of candidates) {
    tried.push(candidate);
    try {
      if (path.isAbsolute(candidate) && !fs.existsSync(candidate)) continue;
      const loaded = require(candidate);
      const playwright = loaded?.chromium ? loaded : loaded?.default;
      if (!playwright?.chromium || typeof playwright.chromium.launch !== 'function') continue;
      return { playwright, resolvedFrom: candidate, tried };
    } catch {}
  }

  const detail = tried.length ? ` Tried: ${tried.join(', ')}` : '';
  const error = new Error(
    `Playwright runtime was not found. Install playwright locally or set E2E_PLAYWRIGHT_PATH to a usable package directory.${detail}`,
  );
  error.tried = tried;
  throw error;
}
function generatedLoaderSource() {
  return loadPlaywrightRuntime.toString();
}

function parseArgs(argv) {
  const args = { candidatePaths: [], includeDefaults: true, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--candidate') args.candidatePaths.push(argv[++index]);
    else if (arg === '--no-defaults') args.includeDefaults = false;
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  return `Usage:
  node resolve_playwright.js [--candidate <package-path>] [--no-defaults] [--json]

Search order includes explicit candidates, E2E_PLAYWRIGHT_PATH, NODE_PATH,
local node_modules, global npm roots, Homebrew roots, and @playwright/cli's bundled runtime.
`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  const resolved = loadPlaywrightRuntime(args);
  const output = {
    status: 'found',
    resolvedFrom: resolved.resolvedFrom,
    hasChromium: Boolean(resolved.playwright.chromium),
    tried: resolved.tried,
  };
  process.stdout.write(args.json ? `${JSON.stringify(output, null, 2)}\n` : `${output.resolvedFrom}\n`);
}

module.exports = { loadPlaywrightRuntime, generatedLoaderSource };

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
