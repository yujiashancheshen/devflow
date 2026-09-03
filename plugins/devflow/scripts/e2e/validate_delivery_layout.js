#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const VERSION_PATTERN = /(?:^|[-_.])v\d+(?=$|[-_.])/i;
const ISO_DATE_PATTERN = /(?:^|[-_.])((?:19|20)\d{2})[-_.](\d{2})[-_.](\d{2})(?:[tT _-](\d{2})(?::?(\d{2}))(?::?(\d{2}))?(?:[zZ]|[-+]\d{2}:?\d{2})?)?(?=$|[-_.])/g;
const COMPACT_DATE_PATTERN = /(?:^|[-_.])((?:19|20)\d{2})(\d{2})(\d{2})(?:[tT _-]?(\d{2})(\d{2})(\d{2})?)?(?=$|[-_.])/g;
const EXPLICIT_TIMESTAMP_PATTERN = /(?:^|[-_.])(?:timestamp|ts)[-_.]\d{10}(?:\d{3})?(?=$|[-_.])/i;
const BARE_EPOCH_PATTERN = /(?:^|[-_.])(\d{13}|\d{10})(?=$|[-_.])/g;
const DUPLICATE_MARKER_PATTERN = /(?:^|[-_.])(?:copy|final|latest|backup)(?=$|[-_.])/i;
const EPOCH_SECONDS_MIN = 1000000000;
const EPOCH_SECONDS_MAX = 4102444800;
const EPOCH_MILLISECONDS_MIN = 1000000000000;
const EPOCH_MILLISECONDS_MAX = 4102444800000;
const REPORT_SCHEMA_VERSION = 1;
const DELIVERY_ROOT_ENTRIES = new Set(['.state', 'cases', 'components']);
const CASE_ROOT_ENTRIES = new Set([
  'artifacts',
  'case.md',
  'delivery-state.json',
  'handoff.json',
  'report.html',
  'result.json',
  'script.js',
]);

function parseArgs(argv) {
  const args = { workspace: process.cwd(), json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--workspace') {
      const value = argv[++index];
      if (!value) throw new Error('--workspace requires a directory');
      args.workspace = value;
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function usage() {
  return 'Usage: node validate_delivery_layout.js [--workspace <directory>] [--json]';
}

function violation(code, targetPath, message) {
  return { code, path: targetPath, message };
}

function isValidDateTime(yearText, monthText, dayText, hourText, minuteText, secondText) {
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return false;
  if (hourText === undefined) return true;
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = secondText === undefined ? 0 : Number(secondText);
  return hour <= 23 && minute <= 59 && second <= 59;
}

function hasValidatedDateOrTimestamp(name) {
  for (const match of name.matchAll(ISO_DATE_PATTERN)) {
    if (isValidDateTime(...match.slice(1, 7))) return true;
  }
  for (const match of name.matchAll(COMPACT_DATE_PATTERN)) {
    if (isValidDateTime(...match.slice(1, 7))) return true;
  }
  if (EXPLICIT_TIMESTAMP_PATTERN.test(name)) return true;
  for (const match of name.matchAll(BARE_EPOCH_PATTERN)) {
    const value = Number(match[1]);
    if (match[1].length === 10 && value >= EPOCH_SECONDS_MIN && value <= EPOCH_SECONDS_MAX) return true;
    if (match[1].length === 13 && value >= EPOCH_MILLISECONDS_MIN && value <= EPOCH_MILLISECONDS_MAX) return true;
  }
  return false;
}

function markerReason(name) {
  if (VERSION_PATTERN.test(name)) return 'version suffixes such as -v2, _v3, or .v4 are not allowed';
  if (hasValidatedDateOrTimestamp(name)) return 'date or timestamp suffixes are not allowed';
  if (DUPLICATE_MARKER_PATTERN.test(name)) return 'duplicate-output markers copy, final, latest, and backup are not allowed';
  return null;
}

function inspectEntry(entryPath, relativePath, violations) {
  let stats;
  try {
    stats = fs.lstatSync(entryPath);
  } catch (error) {
    violations.push(violation('unreadable-entry', relativePath, `Cannot inspect ${entryPath}: ${error.message}`));
    return null;
  }
  if (path.basename(entryPath) === 'case_script') {
    violations.push(violation(
      'legacy-directory',
      relativePath,
      `${relativePath}: legacy case_script directories are not allowed; use cases/<case-id>/script.js`,
    ));
  }
  const reason = markerReason(path.basename(entryPath));
  if (reason) violations.push(violation('unstable-name', relativePath, `${relativePath}: ${reason}`));
  return stats;
}

function scanComponentTree(root, relativeRoot, violations) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    violations.push(violation('unreadable-root', relativeRoot, `Cannot scan ${root}: ${error.message}`));
    return;
  }
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    const relativePath = path.join(relativeRoot, entry.name);
    const stats = inspectEntry(entryPath, relativePath, violations);
    if (!stats) continue;
    if (stats.isSymbolicLink()) {
      violations.push(violation('invalid-component', relativePath, `${relativePath}: component entries must not be symbolic links`));
      continue;
    }
    if (stats.isDirectory()) scanComponentTree(entryPath, relativePath, violations);
    else if (!stats.isFile()) {
      violations.push(violation('invalid-component', relativePath, `${relativePath}: component entries must be regular files or directories`));
    }
  }
}

function scanCaseRoot(caseRoot, relativeCaseRoot, violations) {
  let entries;
  try {
    entries = fs.readdirSync(caseRoot, { withFileTypes: true });
  } catch (error) {
    violations.push(violation('unreadable-root', relativeCaseRoot, `Cannot scan ${caseRoot}: ${error.message}`));
    return;
  }
  for (const entry of entries) {
    const entryPath = path.join(caseRoot, entry.name);
    const relativePath = path.join(relativeCaseRoot, entry.name);
    const stats = inspectEntry(entryPath, relativePath, violations);
    if (!stats) continue;
    if (!CASE_ROOT_ENTRIES.has(entry.name)) {
      violations.push(violation(
        'unexpected-entry',
        relativePath,
        `${relativePath}: Case roots allow only fixed delivery artifacts and artifacts/`,
      ));
      continue;
    }
    if (entry.name === 'artifacts') {
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        violations.push(violation('invalid-artifacts', relativePath, `${relativePath}: artifacts must be a real directory`));
      }
      continue;
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      violations.push(violation('invalid-artifact', relativePath, `${relativePath}: fixed Case artifacts must be regular non-symlink files`));
    }
  }
}

function scanCasesRoot(casesRoot, violations) {
  let entries;
  try {
    entries = fs.readdirSync(casesRoot, { withFileTypes: true });
  } catch (error) {
    violations.push(violation('unreadable-root', 'worktree', `Cannot scan ${casesRoot}: ${error.message}`));
    return;
  }
  for (const entry of entries) {
    const entryPath = path.join(casesRoot, entry.name);
    const relativePath = path.join('worktree', 'cases', entry.name);
    const stats = inspectEntry(entryPath, relativePath, violations);
    if (!stats) continue;
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      violations.push(violation('invalid-case', relativePath, `${relativePath}: each Case must be a real directory`));
      continue;
    }
    scanCaseRoot(entryPath, relativePath, violations);
  }
}

function scanDeliveryRoot(deliveryRoot, violations) {
  let entries;
  try {
    entries = fs.readdirSync(deliveryRoot, { withFileTypes: true });
  } catch (error) {
    violations.push(violation('unreadable-root', 'worktree', `Cannot scan ${deliveryRoot}: ${error.message}`));
    return;
  }
  for (const entry of entries) {
    const entryPath = path.join(deliveryRoot, entry.name);
    const relativePath = path.join('worktree', entry.name);
    const stats = inspectEntry(entryPath, relativePath, violations);
    if (!stats) continue;
    if (!DELIVERY_ROOT_ENTRIES.has(entry.name)) {
      violations.push(violation(
        'unexpected-entry',
        relativePath,
        `${relativePath}: delivery root allows only cases/, components/, and .state/`,
      ));
      continue;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      violations.push(violation('invalid-root', relativePath, `${relativePath}: allowed delivery roots must be real directories`));
      continue;
    }
    if (entry.name === '.state') continue;
    if (entry.name === 'cases') scanCasesRoot(entryPath, violations);
    else scanComponentTree(entryPath, relativePath, violations);
  }
}

function validateDeliveryLayout(workspace) {
  const workspaceRealpath = fs.realpathSync(workspace);
  const deliveryRoot = path.join(workspaceRealpath, 'worktree');
  const violations = [];
  let deliveryStats;
  try {
    deliveryStats = fs.lstatSync(deliveryRoot);
  } catch (error) {
    violations.push(violation('missing-root', 'worktree', `Missing required delivery root: ${deliveryRoot}`));
    return {
      schemaVersion: REPORT_SCHEMA_VERSION,
      status: 'failed',
      workspace: workspaceRealpath,
      scannedRoots: [deliveryRoot],
      violationCount: violations.length,
      violations,
    };
  }
  if (deliveryStats.isSymbolicLink() || !deliveryStats.isDirectory()) {
    violations.push(violation('invalid-root', 'worktree', `Delivery root must be a real directory: ${deliveryRoot}`));
    return {
      schemaVersion: REPORT_SCHEMA_VERSION,
      status: 'failed',
      workspace: workspaceRealpath,
      scannedRoots: [deliveryRoot],
      violationCount: violations.length,
      violations,
    };
  }
  for (const rootName of ['cases', 'components']) {
    const root = path.join(deliveryRoot, rootName);
    let stats;
    try {
      stats = fs.lstatSync(root);
    } catch (error) {
      violations.push(violation('missing-root', path.join('worktree', rootName), `Missing required delivery root: ${root}`));
      continue;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      violations.push(violation('invalid-root', path.join('worktree', rootName), `Delivery root must be a real directory: ${root}`));
      continue;
    }
  }
  scanDeliveryRoot(deliveryRoot, violations);
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    status: violations.length === 0 ? 'passed' : 'failed',
    workspace: workspaceRealpath,
    scannedRoots: [deliveryRoot],
    violationCount: violations.length,
    violations,
  };
}

function printReport(report, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Delivery layout ${report.status}: ${report.violationCount} violation(s)\n`);
  for (const item of report.violations) process.stdout.write(`- ${item.path}: ${item.message}\n`);
}

function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n${usage()}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  let report;
  try {
    report = validateDeliveryLayout(args.workspace);
  } catch (error) {
    report = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      status: 'failed',
      workspace: path.resolve(args.workspace),
      scannedRoots: [],
      violationCount: 1,
      violations: [violation('invalid-workspace', args.workspace, `Cannot resolve workspace: ${error.message}`)],
    };
  }
  printReport(report, args.json);
  return report.status === 'passed' ? 0 : 1;
}

if (require.main === module) process.exitCode = main();

module.exports = { markerReason, validateDeliveryLayout };
