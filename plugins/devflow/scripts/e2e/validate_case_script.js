#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const CONTRACT_START = '/* e2e-contract:start */';
const CONTRACT_END = '/* e2e-contract:end */';
const ALLOWED_STAGE_MODES = new Set(['preflight', 'read-only', 'mutation', 'assertion']);
const ALLOWED_RULE_PHASES = new Set(['mutation', 'certification']);
const ALLOWED_RULE_CATEGORIES = new Set([
  'authentication-state',
  'global-business-context',
  'visible-owner-interaction',
  'teleported-popup-scope',
  'business-container-scope',
  'exact-option-match',
  'linked-field-completion',
  'response-correlation',
  'mutation-checkpoint-resume',
  'observable-final-assertion',
]);

function parseArgs(argv) {
  const args = { out: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--script') args.script = argv[++index];
    else if (arg === '--out') args.out = argv[++index];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  return `Usage:
  node validate_case_script.js --script <case-script.js> [--out <stability-gate.json>]

The command exits 0 when no blocking checks fail and 1 otherwise.`;
}

function lineAt(source, index) {
  if (!Number.isFinite(index) || index < 0) return null;
  return source.slice(0, index).split(/\r?\n/).length;
}

function check(id, status, severity, message, source = '', index = -1) {
  const item = { id, status, severity, message };
  const line = lineAt(source, index);
  if (line) item.line = line;
  return item;
}

function findIndex(source, pattern) {
  const match = pattern.exec(source);
  return match ? match.index : -1;
}

function parseContract(source, checks) {
  const start = source.indexOf(CONTRACT_START);
  const end = source.indexOf(CONTRACT_END);
  if (start < 0 || end < 0 || end <= start) {
    checks.push(check(
      'contract.present',
      'failed',
      'blocking',
      'Embed one JSON execution contract between the e2e-contract markers.',
    ));
    return null;
  }

  checks.push(check('contract.present', 'passed', 'blocking', 'Execution contract markers are present.'));
  const raw = source.slice(start + CONTRACT_START.length, end).trim();
  try {
    const contract = JSON.parse(raw);
    checks.push(check('contract.valid-json', 'passed', 'blocking', 'Execution contract is valid JSON.'));
    return contract;
  } catch (error) {
    checks.push(check(
      'contract.valid-json',
      'failed',
      'blocking',
      `Execution contract is not valid JSON: ${error.message}`,
      source,
      start,
    ));
    return null;
  }
}

function validateContract(contract, source, checks) {
  if (!contract) return;

  checks.push(check(
    'contract.schema-version',
    contract.schemaVersion === 2 ? 'passed' : 'failed',
    'blocking',
    contract.schemaVersion === 2
      ? 'Execution contract schema version is supported.'
      : 'Execution contract schemaVersion must be 2; legacy scripts require migration and recertification.',
  ));

  const rules = Array.isArray(contract.stabilityRules) ? contract.stabilityRules : null;
  const ruleIds = (rules || []).map((rule) => rule?.id).filter(Boolean);
  const ruleShapeValid = rules !== null
    && rules.length > 0
    && ruleIds.length === rules.length
    && new Set(ruleIds).size === ruleIds.length
    && rules.every((rule) => rule.id === rule.category
      && ALLOWED_RULE_CATEGORIES.has(rule.category)
      && ALLOWED_RULE_PHASES.has(rule.requiredBefore)
      && typeof rule.reason === 'string' && rule.reason.trim()
      && Array.isArray(rule.sourceRefs) && rule.sourceRefs.length > 0
      && Array.isArray(rule.evidenceRefs) && rule.evidenceRefs.length > 0);
  checks.push(check(
    'contract.stability-rule-shape',
    ruleShapeValid ? 'passed' : 'failed',
    'blocking',
    ruleShapeValid
      ? 'Applicable stability rules are complete and uniquely identified.'
      : 'stabilityRules must be an array of unique complete generic rule declarations.',
  ));

  const stages = Array.isArray(contract.stages) ? contract.stages : [];
  const keys = stages.map((stage) => stage && stage.key).filter(Boolean);
  const uniqueKeys = new Set(keys);
  const shapeValid = stages.length > 0
    && keys.length === stages.length
    && uniqueKeys.size === keys.length
    && stages.every((stage) => ALLOWED_STAGE_MODES.has(stage.mode));
  checks.push(check(
    'contract.stage-shape',
    shapeValid ? 'passed' : 'failed',
    'blocking',
    shapeValid
      ? 'Stage keys are unique and stage modes are supported.'
      : 'Contract stages must be non-empty, uniquely keyed, and use a supported mode.',
  ));
  if (!shapeValid) return;

  const mutationIndexes = stages
    .map((stage, index) => (stage.mode === 'mutation' ? index : -1))
    .filter((index) => index >= 0);
  const firstMutation = mutationIndexes.length ? mutationIndexes[0] : -1;
  const lastMutation = mutationIndexes.length ? mutationIndexes[mutationIndexes.length - 1] : -1;
  const preflightIndex = stages.findIndex((stage) => stage.mode === 'preflight');
  const preflight = stages[preflightIndex];
  const preflightValid = preflightIndex >= 0
    && (firstMutation < 0 || preflightIndex < firstMutation)
    && Array.isArray(preflight.evidence)
    && preflight.evidence.length > 0;
  checks.push(check(
    'contract.preflight-before-mutation',
    preflightValid ? 'passed' : 'failed',
    'blocking',
    preflightValid
      ? 'A preflight with declared evidence precedes every mutation.'
      : 'Declare a preflight stage with evidence before the first mutation.',
  ));

  const unsafeMutation = stages.find((stage) => stage.mode === 'mutation'
    && stage.irreversible === true
    && (!stage.checkpointKey || typeof stage.checkpointKey !== 'string'));
  checks.push(check(
    'contract.mutation-checkpoint',
    unsafeMutation ? 'failed' : 'passed',
    'blocking',
    unsafeMutation
      ? `Irreversible mutation stage "${unsafeMutation.key}" must declare checkpointKey.`
      : 'Every irreversible mutation declares checkpoint metadata.',
  ));

  const finalAssertionIndex = stages.findLastIndex((stage) => stage.mode === 'assertion' && stage.observable === true);
  const finalAssertionValid = finalAssertionIndex >= 0
    && (lastMutation < 0 || finalAssertionIndex > lastMutation);
  checks.push(check(
    'contract.final-assertion',
    finalAssertionValid ? 'passed' : 'failed',
    'blocking',
    finalAssertionValid
      ? 'An observable assertion follows the final mutation.'
      : 'Declare an observable assertion after the final mutation.',
  ));
}

function addSourceRule(checks, source, options) {
  const index = findIndex(source, options.pattern);
  if (index >= 0) {
    checks.push(check(options.id, options.failureStatus, options.severity, options.failureMessage, source, index));
  } else {
    checks.push(check(options.id, 'passed', options.severity, options.passMessage));
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findMatchingBrace(source, openIndex) {
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function runStepCallbacks(source, stages) {
  const callbacks = [];
  const pattern = /runStep\s*\(\s*[^,]+,\s*(['"])([^'"]+)\1\s*,\s*async\s*\([^)]*\)\s*=>\s*\{/g;
  for (const match of source.matchAll(pattern)) {
    const openIndex = match.index + match[0].length - 1;
    const closeIndex = findMatchingBrace(source, openIndex);
    if (closeIndex < 0) continue;
    const stageIndex = stages.findIndex((stage) => stage.key === match[2]);
    callbacks.push({
      stage: stageIndex >= 0 ? stages[stageIndex] : null,
      stageIndex,
      body: source.slice(openIndex + 1, closeIndex),
    });
  }
  return callbacks;
}

function stripJavaScriptComments(source) {
  let result = '';
  let quote = '';
  let escaped = false;
  let regex = false;
  let regexClass = false;
  let lineComment = false;
  let blockComment = false;
  let lastSignificant = '';

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === '\n') {
        lineComment = false;
        result += char;
      } else result += ' ';
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        result += '  ';
        index += 1;
        blockComment = false;
      } else result += char === '\n' ? '\n' : ' ';
      continue;
    }
    if (quote) {
      result += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (regex) {
      result += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '[') regexClass = true;
      else if (char === ']') regexClass = false;
      else if (char === '/' && !regexClass) {
        regex = false;
        lastSignificant = '/';
      }
      continue;
    }
    if (char === '/' && next === '/') {
      result += '  ';
      index += 1;
      lineComment = true;
      continue;
    }
    if (char === '/' && next === '*') {
      result += '  ';
      index += 1;
      blockComment = true;
      continue;
    }
    if (char === '/' && (!lastSignificant || /[([{=,:;!&|?+\-*%^~<>]/.test(lastSignificant))) {
      regex = true;
      regexClass = false;
      escaped = false;
      result += char;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') quote = char;
    result += char;
    if (!/\s/.test(char)) lastSignificant = char;
  }
  return result;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function resolveLocalDependency(importerPath, request) {
  const base = path.resolve(path.dirname(importerPath), request);
  const candidates = [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, path.join(base, 'index.js')];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || null;
}

function collectLocalDependencies(entryPath) {
  const visited = new Set([path.resolve(entryPath)]);
  const dependencies = [];

  function visit(importerPath) {
    const source = stripJavaScriptComments(fs.readFileSync(importerPath, 'utf8'));
    const requests = [];
    const pattern = /(?:require\s*\(\s*|\bfrom\s+|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
    for (const match of source.matchAll(pattern)) requests.push(match[1]);

    for (const request of requests) {
      const dependencyPath = resolveLocalDependency(importerPath, request);
      if (!dependencyPath || visited.has(dependencyPath)) continue;
      visited.add(dependencyPath);
      dependencies.push({ path: dependencyPath, sha256: sha256File(dependencyPath) });
      if (/\.(?:c?js|mjs)$/.test(dependencyPath)) visit(dependencyPath);
    }
  }

  visit(path.resolve(entryPath));
  return dependencies;
}

function validateContractSource(source, contract, checks) {
  const stages = Array.isArray(contract?.stages) ? contract.stages : [];
  if (!stages.length) return;
  const executableSource = stripJavaScriptComments(source);
  const callbacks = runStepCallbacks(executableSource, stages);

  const missingImplementations = stages.filter((stage) => {
    const key = escapeRegExp(stage.key);
    return !new RegExp(`runStep\\s*\\(\\s*[^,]+,\\s*['"]${key}['"]`).test(executableSource);
  });
  checks.push(check(
    'source.stage-implementation',
    missingImplementations.length ? 'failed' : 'passed',
    'blocking',
    missingImplementations.length
      ? `Contract stages are not implemented with runStep: ${missingImplementations.map((stage) => stage.key).join(', ')}`
      : 'Every contract stage has a runStep implementation.',
  ));

  const missingRuleCalls = (contract.stabilityRules || []).filter((rule) => {
    const id = escapeRegExp(rule.id);
    const callPattern = new RegExp(`recordStabilityRule\\s*\\(\\s*[^,]+,\\s*['"]${id}['"]`);
    const firstMutation = stages.findIndex((stage) => stage.mode === 'mutation');
    const finalAssertion = stages.findLastIndex((stage) => stage.mode === 'assertion' && stage.observable === true);
    return !callbacks.some((callback) => {
      if (!callPattern.test(callback.body) || !callback.stage) return false;
      if (rule.requiredBefore === 'mutation') {
        return ['preflight', 'read-only'].includes(callback.stage.mode)
          && (firstMutation < 0 || callback.stageIndex < firstMutation);
      }
      return finalAssertion >= 0 && callback.stageIndex <= finalAssertion;
    });
  });
  checks.push(check(
    'source.stability-rule-recording',
    missingRuleCalls.length ? 'failed' : 'passed',
    'blocking',
    missingRuleCalls.length
      ? `Applicable stability rules lack an explicit runtime recording call inside an eligible runStep callback: ${missingRuleCalls.map((rule) => rule.id).join(', ')}`
      : 'Every applicable stability rule has an explicit runtime recording call before its phase cutoff.',
  ));

  const missingCheckpoints = stages.filter((stage) => {
    if (stage.mode !== 'mutation' || stage.irreversible !== true) return false;
    const key = escapeRegExp(stage.key);
    return !new RegExp(`persistCheckpoint\\s*\\(\\s*[^,]+,\\s*['"]${key}['"]`).test(executableSource);
  });
  checks.push(check(
    'source.checkpoint-persistence',
    missingCheckpoints.length ? 'failed' : 'passed',
    'blocking',
    missingCheckpoints.length
      ? `Irreversible stages do not persist their declared checkpoint: ${missingCheckpoints.map((stage) => stage.key).join(', ')}`
      : 'Every irreversible stage explicitly persists checkpoint evidence.',
  ));

  const missingAssertions = stages.filter((stage) => {
    if (stage.mode !== 'assertion' || stage.observable !== true) return false;
    const key = escapeRegExp(stage.key);
    return !new RegExp(`recordAssertionEvidence\\s*\\(\\s*[^,]+,\\s*['"]${key}['"]`).test(executableSource);
  });
  checks.push(check(
    'source.assertion-evidence',
    missingAssertions.length ? 'failed' : 'passed',
    'blocking',
    missingAssertions.length
      ? `Observable assertion stages do not record evidence: ${missingAssertions.map((stage) => stage.key).join(', ')}`
      : 'Every observable assertion explicitly records evidence.',
  ));
}

function validateSource(source, contract, checks) {
  validateContractSource(source, contract, checks);
  addSourceRule(checks, source, {
    id: 'source.no-case-todo',
    pattern: /TODO\(case\)/,
    severity: 'blocking',
    failureStatus: 'failed',
    failureMessage: 'Replace every TODO(case) placeholder before execution.',
    passMessage: 'No unfinished case placeholders were found.',
  });
  addSourceRule(checks, source, {
    id: 'source.no-force-click',
    pattern: /\.click\s*\(\s*\{[\s\S]{0,160}?\bforce\s*:\s*true\b/,
    severity: 'blocking',
    failureStatus: 'failed',
    failureMessage: 'Forced clicks bypass user-visible interaction; use the visible owner element.',
    passMessage: 'No forced clicks were found.',
  });
  addSourceRule(checks, source, {
    id: 'source.no-body-value-assertion',
    pattern: /locator\(\s*['"]body['"]\s*\)\.innerText\(\)[\s\S]{0,320}?includes\(\s*[^)]*(?:value|input|placeholder)/i,
    severity: 'blocking',
    failureStatus: 'failed',
    failureMessage: 'Read form values and placeholders from their controls, not body.innerText.',
    passMessage: 'No body-text form value assertion was found.',
  });
  addSourceRule(checks, source, {
    id: 'source.response-wait-before-action',
    pattern: /\.(?:click|press|fill|check|selectOption)\([\s\S]{0,220}?\);\s*(?:const\s+\w+\s*=\s*)?await\s+[^;\n]*waitForResponse\s*\(/,
    severity: 'blocking',
    failureStatus: 'failed',
    failureMessage: 'Register waitForResponse before the UI action, preferably in Promise.all.',
    passMessage: 'No response wait registered after its likely trigger was found.',
  });
  addSourceRule(checks, source, {
    id: 'source.visible-state-control',
    pattern: /locator\(\s*(?:'[^']*(?:input\s*\[\s*type\s*=\s*["']?(?:radio|checkbox)|__original)[^']*'|"[^"]*(?:input\s*\[\s*type\s*=\s*["']?(?:radio|checkbox)|__original)[^"]*")\s*\)[\s\S]{0,100}?\.click\s*\(/i,
    severity: 'warning',
    failureStatus: 'warning',
    failureMessage: 'A hidden/internal state control may be clicked; verify and click its visible wrapper.',
    passMessage: 'No direct click on a likely hidden state control was found.',
  });
  addSourceRule(checks, source, {
    id: 'source.scoped-teleport',
    pattern: /page\.locator\(\s*['"]\.(?:el-popper|ant-select-dropdown|ant-picker-dropdown)['"]\s*\)/,
    severity: 'warning',
    failureStatus: 'warning',
    failureMessage: 'A teleported popup locator is page-wide; verify visibility and scope to the current popup.',
    passMessage: 'No unscoped known teleported popup locator was found.',
  });
}

function validateAutomationModuleSources(dependencies, checks) {
  for (const dependency of dependencies) {
    if (!/\.(?:c?js|mjs)$/.test(dependency.path)) continue;
    const source = fs.readFileSync(dependency.path, 'utf8');
    const dependencyChecks = [];
    validateSource(source, null, dependencyChecks);
    const launchIndex = findIndex(source, /\b(?:chromium|firefox|webkit|browserType)\.launch(?:PersistentContext)?\s*\(/);
    dependencyChecks.push(check(
      'automation-module.no-browser-launch',
      launchIndex >= 0 ? 'failed' : 'passed',
      'blocking',
      launchIndex >= 0
        ? 'Reusable automation modules must use the caller browser/context/page and cannot launch a browser.'
        : 'Automation module does not launch a separate browser.',
      source,
      launchIndex,
    ));
    for (const item of dependencyChecks) checks.push({ ...item, file: dependency.path });
  }
}

function validateScript(script) {
  const resolved = path.resolve(script);
  const report = {
    schemaVersion: 1,
    status: 'failed',
    script: resolved,
    contract: null,
    checks: [],
    blockingCount: 0,
    warningCount: 0,
  };

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    report.checks.push(check('script.readable', 'failed', 'blocking', `Script does not exist: ${resolved}`));
    report.blockingCount = 1;
    return report;
  }

  const source = fs.readFileSync(resolved, 'utf8');
  report.scriptSha256 = sha256File(resolved);
  report.automationModuleDependencies = collectLocalDependencies(resolved);
  const syntax = spawnSync(process.execPath, ['--check', resolved], { encoding: 'utf8' });
  report.checks.push(check(
    'script.syntax',
    syntax.status === 0 ? 'passed' : 'failed',
    'blocking',
    syntax.status === 0 ? 'Node.js syntax check passed.' : (syntax.stderr || syntax.stdout || 'Node.js syntax check failed.').trim(),
  ));

  const contract = parseContract(source, report.checks);
  report.contract = contract;
  validateContract(contract, source, report.checks);
  validateSource(source, contract, report.checks);
  validateAutomationModuleSources(report.automationModuleDependencies, report.checks);
  report.blockingCount = report.checks.filter((item) => item.severity === 'blocking' && item.status === 'failed').length;
  report.warningCount = report.checks.filter((item) => item.status === 'warning').length;
  report.status = report.blockingCount === 0 ? 'passed' : 'failed';
  return report;
}

function writeReport(report, out) {
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (out) {
    const resolved = path.resolve(out);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, json);
  }
  process.stdout.write(json);
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!args.script) {
    process.stderr.write(`Missing --script.\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }

  const report = validateScript(args.script);
  writeReport(report, args.out);
  if (report.status !== 'passed') process.exitCode = 1;
}

module.exports = {
  CONTRACT_END,
  CONTRACT_START,
  validateScript,
};

if (require.main === module) main();
