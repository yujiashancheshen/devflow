#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { extractMarkdownCases } = require('./extract_markdown_cases');
const { generatedLoaderSource } = require('./resolve_playwright');

const STABILITY_RULE_CATEGORIES = new Set([
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
const DEFAULT_STABILITY_RULES = [{
  id: 'observable-final-assertion',
  category: 'observable-final-assertion',
  requiredBefore: 'certification',
  reason: 'Every successful run requires observable final assertion evidence.',
  sourceRefs: ['generated-case-source'],
  evidenceRefs: ['runtime-page-observation'],
}];

function parseArgs(argv) {
  const args = {
    caseName: 'webapp-case',
    handoff: null,
    out: null,
    baseUrl: 'http://localhost:3000',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--case') {
      args.caseName = argv[++i];
    } else if (arg === '--handoff') {
      args.handoff = argv[++i];
    } else if (arg === '--out') {
      args.out = argv[++i];
    } else if (arg === '--base-url') {
      args.baseUrl = argv[++i];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function usage() {
  return `Usage:
  node scripts/create_case_script.js --case <case-name-or-file> --base-url <url>
  node scripts/create_case_script.js --case <case-file> --out worktree/<需求名>/docs/e2e/script.js --base-url <url>

Options:
  --case      Case title or path to a Case/PRD Markdown document. F0 headings are embedded as a Case catalog.
  --handoff   Optional legacy handoff JSON for importing previously selected automation modules.
  --out       Optional output JS path. Should be worktree/<需求名>/docs/e2e/script.js
  --base-url  Default base URL in generated script. Default: http://localhost:3000
`;
}

function caseTitleForPath(caseName) {
  if (caseName && fs.existsSync(caseName) && fs.statSync(caseName).isFile()) {
    // devflow: worktree/<需求名>/docs/xxx.md → 提取需求名
    const resolved = path.resolve(caseName);
    const worktreeIdx = resolved.indexOf('/worktree/');
    if (worktreeIdx !== -1) {
      const afterWorktree = resolved.slice(worktreeIdx + '/worktree/'.length);
      const parts = afterWorktree.split('/');
      if (parts.length >= 2 && parts[0] && parts[0] !== '.' && parts[0] !== '..') {
        return parts[0];
      }
    }
    return path.basename(caseName, path.extname(caseName));
  }
  return caseName || 'webapp-case';
}

function slugifyCaseName(caseName) {
  const normalized = String(caseTitleForPath(caseName))
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const slug = normalized
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return slug || 'webapp-case';
}

function isSafeCaseId(caseId) {
  return typeof caseId === 'string' && /^[\p{Letter}\p{Number}_-]+$/u.test(caseId);
}

function defaultOutputPath(caseName, handoff) {
  const caseId = handoff?.caseId || slugifyCaseName(caseName);
  if (!isSafeCaseId(caseId)) {
    throw new Error('caseId must be exactly one safe directory segment using letters, numbers, hyphens, or underscores');
  }
  const casesRoot = path.resolve(process.cwd(), 'worktree');
  const caseDir = path.resolve(casesRoot, caseId);
  const relativeCaseDir = path.relative(casesRoot, caseDir);
  if (
    !relativeCaseDir ||
    relativeCaseDir === '..' ||
    relativeCaseDir.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeCaseDir) ||
    relativeCaseDir.includes(path.sep)
  ) {
    throw new Error('caseId must resolve beneath the worktree root');
  }
  return path.join(caseDir, 'docs', 'e2e', 'script.js');
}

function lstatIfPresent(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function assertNoSymlinkPathSegments(workspace, targetPath) {
  const relative = path.relative(workspace, targetPath);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Canonical script path must stay inside the current workspace: ${targetPath}`);
  }
  let current = workspace;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const metadata = lstatIfPresent(current);
    if (!metadata) break;
    if (metadata.isSymbolicLink()) {
      throw new Error(`Canonical script path must not contain a symlink: ${current}`);
    }
    if (!metadata.isDirectory()) {
      throw new Error(`Canonical script path segment must be a directory: ${current}`);
    }
  }
}

function assertCanonicalOutputFile(out) {
  const metadata = lstatIfPresent(out);
  if (!metadata) return;
  if (metadata.isSymbolicLink()) {
    throw new Error(`Canonical script output must not be a symlink: ${out}`);
  }
  if (!metadata.isFile()) {
    throw new Error(`Canonical script output must be a regular file: ${out}`);
  }
  if (fs.realpathSync(out) !== out) {
    throw new Error(`Canonical script output realpath must equal its fixed path: ${out}`);
  }
}

function prepareCanonicalOutputPath(workspace, out) {
  const outputDirectory = path.dirname(out);
  assertNoSymlinkPathSegments(workspace, outputDirectory);
  assertCanonicalOutputFile(out);
  fs.mkdirSync(outputDirectory, { recursive: true });
  assertNoSymlinkPathSegments(workspace, outputDirectory);
  if (fs.realpathSync(outputDirectory) !== outputDirectory) {
    throw new Error(`Canonical script directory realpath must equal its fixed path: ${outputDirectory}`);
  }
  assertCanonicalOutputFile(out);
}

function writeCanonicalScript(out, content) {
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let descriptor;
  try {
    descriptor = fs.openSync(
      out,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | noFollow,
      0o755,
    );
    if (!fs.fstatSync(descriptor).isFile()) {
      throw new Error(`Canonical script output must be a regular file: ${out}`);
    }
    fs.writeFileSync(descriptor, content);
    fs.fchmodSync(descriptor, 0o755);
  } catch (error) {
    if (error.code === 'ELOOP') {
      throw new Error(`Canonical script output must not be a symlink: ${out}`);
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readCaseSummary(caseName) {
  if (caseName && fs.existsSync(caseName) && fs.statSync(caseName).isFile()) {
    const text = fs.readFileSync(caseName, 'utf8');
    return text.split(/\r?\n/).slice(0, 40).join('\n').trim();
  }
  return caseName;
}

function readCaseDefinition(caseName, caseId) {
  if (caseName && fs.existsSync(caseName) && fs.statSync(caseName).isFile()) {
    const casePath = path.resolve(caseName);
    const text = fs.readFileSync(casePath, 'utf8');
    const heading = text.match(/^#\s+(.+?)\s*$/m);
    const title = heading ? heading[1].trim() : path.basename(casePath, path.extname(casePath));
    const extracted = extractMarkdownCases(text);
    return {
      title,
      path: casePath,
      summary: text.split(/\r?\n/).slice(0, 40).join('\n').trim(),
      catalog: extracted.length ? extracted : [{
        caseId,
        title,
        requirement: '',
        preconditions: [],
        steps: [],
        expectedResults: [],
      }],
    };
  }
  const title = String(caseName || 'webapp-case');
  return {
    title,
    path: '',
    summary: title,
    catalog: [{
      caseId,
      title,
      requirement: '',
      preconditions: [],
      steps: [],
      expectedResults: [],
    }],
  };
}

function jsString(value) {
  return JSON.stringify(String(value));
}

function loadHandoff(handoffPath, caseName) {
  if (!handoffPath) return null;

  // DevFlow: handoff is optional. Return early with minimal validation.
  const absoluteHandoffPath = path.resolve(handoffPath);
  const handoff = JSON.parse(fs.readFileSync(absoluteHandoffPath, 'utf8'));
  return { path: absoluteHandoffPath, value: handoff };
}

function createAutomationModuleImports(handoffRecord, outPath) {
  if (!handoffRecord) return { imports: '', dependencies: [] };

  const imports = [];
  const dependencies = [];
  const outputDirectoryPath = path.dirname(path.resolve(outPath));
  const outputDirectory = fs.existsSync(outputDirectoryPath)
    ? fs.realpathSync(outputDirectoryPath)
    : outputDirectoryPath;
  const handoffDirectory = path.dirname(handoffRecord.path);
  for (const automationModule of handoffRecord.value.automationModules || []) {
    const unresolvedModulePath = path.resolve(handoffDirectory, automationModule.path);
    const modulePath = fs.existsSync(unresolvedModulePath)
      ? fs.realpathSync(unresolvedModulePath)
      : unresolvedModulePath;
    if (!fs.existsSync(modulePath) || !fs.statSync(modulePath).isFile()) {
      throw new Error(`selected automation module does not exist: ${modulePath}`);
    }
    const exportedNames = automationModule.exports.map((name) => {
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
        throw new Error(`invalid automation module export name: ${name}`);
      }
      return name;
    });
    let relativePath = path.relative(outputDirectory, modulePath).split(path.sep).join('/');
    if (!relativePath.startsWith('.')) relativePath = `./${relativePath}`;
    imports.push(`const { ${exportedNames.join(', ')} } = require(${JSON.stringify(relativePath)});`);
    dependencies.push({
      id: automationModule.id || path.basename(modulePath, path.extname(modulePath)),
      path: modulePath,
      exports: exportedNames,
    });
  }
  return { imports: imports.join('\n'), dependencies };
}

function template({ caseName, caseTitle, casePath, caseSummary, caseCatalog, baseUrl, handoff, automationModuleImports, automationModuleDependencies }) {
  const stabilityRules = handoff?.stabilityRules || DEFAULT_STABILITY_RULES;
  const playwrightLoaderSource = generatedLoaderSource();
  const recordingCalls = (requiredBefore) => stabilityRules
    .filter((rule) => rule.requiredBefore === requiredBefore)
    .map((rule) => `      recordStabilityRule(ctx, ${JSON.stringify(rule.id)}, {\n        status: 'applied',\n        evidence: {\n          verified: true,\n          observation: 'TODO(case): observable runtime evidence for ${rule.id}',\n        },\n      });`)
    .join('\n');
  const mutationRuleCalls = recordingCalls('mutation');
  const certificationRuleCalls = recordingCalls('certification');
  return `#!/usr/bin/env node

/**
 * Generated from case: ${caseName}
 *
 * Case summary:
${caseSummary.split(/\r?\n/).map((line) => ` * ${line}`).join('\n')}
 */

const fs = require('fs');
const path = require('path');
${automationModuleImports}

${playwrightLoaderSource}

const CASE_HANDOFF = ${JSON.stringify(handoff, null, 2)};
const AUTOMATION_MODULE_DEPENDENCIES = ${JSON.stringify(automationModuleDependencies, null, 2)};
const CASE_CATALOG = ${JSON.stringify(caseCatalog, null, 2)};
// For a batch Case, map every executable step to one or more Case IDs before running.
const STEP_CASE_MAP = ${JSON.stringify(caseCatalog.length === 1 ? {
    'case-action': [caseCatalog[0].caseId],
    'assert-result': [caseCatalog[0].caseId],
  } : {}, null, 2)};

const MAX_NETWORK_BODY_BYTES = 65_536;
const NETWORK_RESOURCE_TYPES = new Set(['xhr', 'fetch']);
const SENSITIVE_KEY_PATTERN = /cookie|authorization|password|passwd|secret|session|token|ticket|credential|api[-_]?key/i;
const SENSITIVE_PATH_KEY_PATTERN = /^(cookie|authorization|password|passwd|secret|session|token|ticket|credential|api[-_]?key)$/i;
const ACTIVE_STABILITY_STAGES = new WeakMap();

const STEP_REPORTS = [
  ['preflight', '只读浏览器预检'],
  ['case-action', '执行业务动作'],
  ['assert-result', '校验结果'],
];

const E2E_EXECUTION_CONTRACT =
/* e2e-contract:start */
{
  "schemaVersion": 2,
  "stabilityRules": ${JSON.stringify(stabilityRules, null, 2)},
  "stages": [
    {
      "key": "preflight",
      "mode": "preflight",
      "evidence": [
        "TODO(case): authenticated shell",
        "TODO(case): verified global context",
        "TODO(case): required configuration and unique dependent records"
      ]
    },
    {
      "key": "case-action",
      "mode": "mutation",
      "irreversible": true,
      "checkpointKey": "case-action"
    },
    {
      "key": "assert-result",
      "mode": "assertion",
      "observable": true
    }
  ]
}
/* e2e-contract:end */;

const CASE_CONTEXT_MAPPING = {
  stepCaseMap: STEP_CASE_MAP,
  inputs: [
    {
      key: '--base-url',
      zhName: '中文名 TODO(case): 应用地址',
      enName: 'English name TODO(case): application base URL',
      resultKey: 'baseUrl',
      frontendSource: 'TODO(case): route config, environment file, or deployment doc',
      uiNode: 'TODO(case): page entry or shell navigation node',
      notes: 'Replace this placeholder after reading the case markdown and frontend source.',
    },
  ],
  reportFields: [
    {
      key: 'baseUrl',
      zhName: '中文名 TODO(case): 应用地址',
      enName: 'baseUrl',
      source: 'result',
      frontendSource: 'TODO(case): route config, environment file, or deployment doc',
      notes: 'Report display metadata. Add case-specific input/ID keys here.',
    },
  ],
  features: [
    {
      key: 'case-action',
      zhName: '中文名 TODO(case): 业务功能',
      enName: 'English name TODO(case): business feature',
      frontendSource: 'TODO(case): page/component/module implementing this feature',
      notes: 'Map feature names from product wording to source-code identifiers.',
    },
  ],
  nodes: [
    {
      key: 'primary-form',
      zhName: '中文名 TODO(case): 页面节点',
      enName: 'English name TODO(case): page node',
      frontendSource: 'TODO(case): component, form item, selector, or route container',
      selectorStrategy: 'TODO(case): visible UI locator strategy',
    },
  ],
  scenes: [
    {
      key: 'happy-path',
      zhName: '中文名 TODO(case): 主流程场景',
      enName: 'English name TODO(case): happy-path scenario',
      frontendSource: 'TODO(case): scenario doc, case markdown, or related page flow',
      expectedResult: 'TODO(case): visible final assertion',
    },
  ],
  endpoints: [
    {
      key: 'observed-ui-response',
      zhName: '中文名 TODO(case): UI 触发接口',
      enName: 'English name TODO(case): UI-triggered endpoint',
      frontendSource: 'TODO(case): request module and API enum',
      method: 'TODO(case): GET/POST',
      url: 'TODO(case): endpoint path observed from UI action',
    },
  ],
};

function parseArgs(argv) {
  const args = {
    baseUrl: ${jsString(baseUrl)},
    headed: false,
    artifactDir: null,
    recordVideo: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base-url') args.baseUrl = argv[++i];
    else if (arg === '--headed') args.headed = true;
    else if (arg === '--record-video') args.recordVideo = true;
    else if (arg === '--no-record-video') args.recordVideo = false;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--preflight-only') args.preflightOnly = true;
    else if (arg === '--storage-state') args.storageState = argv[++i];
    else if (arg === '--cookie') args.cookie = argv[++i];
    else if (arg === '--artifact-dir') args.artifactDir = path.resolve(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      console.log(\`Usage: node \${path.basename(process.argv[1])} [--base-url URL] [--headed] [--record-video|--no-record-video] [--dry-run] [--preflight-only] [--storage-state file] [--cookie name=value] [--artifact-dir dir]\`);
      process.exit(0);
    } else {
      throw new Error(\`Unknown argument: \${arg}\`);
    }
  }

  return args;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function buildBrowserContextOptions(args = {}, { viewport, storageState } = {}) {
  const options = { viewport };
  if (storageState) options.storageState = storageState;
  if (args.recordVideo) {
    const videoDir = path.join(args.artifactDir, 'videos');
    ensureDir(videoDir);
    options.recordVideo = { dir: videoDir, size: viewport };
  }
  return options;
}

function trackPageVideo(ctx, page, evidence = {}) {
  if (!ctx?.args?.recordVideo || !page || typeof page.video !== 'function') return null;
  const video = page.video();
  if (!video) return null;
  ctx.pendingVideoArtifacts ||= [];
  const record = { video, ...evidence };
  ctx.pendingVideoArtifacts.push(record);
  return record;
}

async function finalizeVideoArtifacts(ctx, records = ctx.pendingVideoArtifacts || []) {
  ctx.result.videoRecording ||= {
    enabled: Boolean(ctx.args?.recordVideo),
    directory: path.join(ctx.artifactDir, 'videos'),
    artifacts: [],
  };
  ctx.result.videoRecording.artifacts ||= [];
  for (const record of records) {
    if (!record?.video || record.finalized) continue;
    record.finalized = true;
    try {
      const videoPath = await record.video.path();
      if (!videoPath) continue;
      const artifact = {
        role: record.role || '主页面',
        step: record.step || '',
        context: record.context || 'browser',
        path: videoPath,
      };
      if (!ctx.result.videoRecording.artifacts.some((item) => item.path === videoPath)) {
        ctx.result.videoRecording.artifacts.push(artifact);
      }
      if (artifact.step) {
        ctx.result.stepArtifacts ||= {};
        ctx.result.stepArtifacts[artifact.step] ||= {};
        ctx.result.stepArtifacts[artifact.step].videos ||= [];
        if (!ctx.result.stepArtifacts[artifact.step].videos.includes(videoPath)) {
          ctx.result.stepArtifacts[artifact.step].videos.push(videoPath);
        }
      }
    } catch (error) {
      record.finalizationError = String(error?.message || error);
    }
  }
  writeJson(ctx.resultFile, ctx.result);
}

function extractTraceId(headers) {
  const entry = Object.entries(headers || {}).find(([name]) => name.toLowerCase() === 'x-trace-id');
  return entry ? String(entry[1]) : '';
}

function sanitizeEvidenceText(value) {
  const text = String(value || '');
  if (/\\b(?:authorization|proxy-authorization)\\s*[:=]\\s*Digest\\b/i.test(text)
      || /\\b(?:cookie|set-cookie)\\s*[:=][^\\r\\n]*(?:;|,)/i.test(text)) {
    return '[sensitive diagnostic omitted]';
  }
  return text
    .replace(/\\b(authorization|proxy-authorization)\\s*[:=]\\s*(?:(?:Bearer|Basic)\\s+)?[^\\s,;]+/gi, '$1: ***')
    .replace(/\\b(cookie|set-cookie)\\s*([:=])\\s*[^\\s,;]+/gi, '$1$2***')
    .replace(/\\bBearer\\s+[^\\s,;]+/gi, 'Bearer ***')
    .replace(/\\b(password|passwd|secret|session|token|ticket|credential|access[-_]?token|api[-_]?key|client[-_]?secret)\\b["']?\\s*([:=])\\s*["']?[^"'\\s&#,;}]+/gi, '$1$2***')
    .replace(/\\b(1\\d{2})\\d{4}(\\d{4})\\b/g, '$1****$2')
    .replace(/\\b(\\d{6})\\d{8}([0-9Xx]{4})\\b/g, '$1********$2');
}

function sanitizeEvidenceValue(value, key = '') {
  const normalizedKey = key.toLowerCase();
  if (normalizedKey === 'x-trace-id') return '***';
  if (SENSITIVE_KEY_PATTERN.test(key)) return '***';
  if (Array.isArray(value)) return value.map((item) => sanitizeEvidenceValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      sanitizeEvidenceValue(childValue, childKey),
    ]));
  }
  if (typeof value !== 'string') return value;
  return sanitizeEvidenceText(value);
}

function sanitizeResponseHeaders(headers) {
  const sanitized = sanitizeEvidenceValue(headers || {});
  const traceEntry = Object.entries(headers || {}).find(([name]) => name.toLowerCase() === 'x-trace-id');
  if (traceEntry) sanitized[traceEntry[0]] = String(traceEntry[1]);
  return sanitized;
}

function sanitizeUrl(value) {
  try {
    const url = new URL(value);
    if (url.username) url.username = '***';
    if (url.password) url.password = '***';
    let redactNextPathSegment = false;
    url.pathname = url.pathname.split('/').map((segment) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {}
      if (redactNextPathSegment) {
        redactNextPathSegment = false;
        return '***';
      }
      if (SENSITIVE_PATH_KEY_PATTERN.test(decoded)) {
        redactNextPathSegment = true;
      } else if (SENSITIVE_KEY_PATTERN.test(decoded)) {
        return '***';
      }
      return encodeURIComponent(sanitizeEvidenceText(decoded));
    }).join('/');
    for (const name of new Set(url.searchParams.keys())) {
      const values = url.searchParams.getAll(name).map((item) => sanitizeEvidenceValue(item, name));
      url.searchParams.delete(name);
      for (const item of values) url.searchParams.append(name, String(item));
    }
    if (url.hash) {
      const hashText = url.hash.slice(1);
      if (hashText.includes('=')) {
        const hashParams = new URLSearchParams(hashText);
        for (const name of new Set(hashParams.keys())) {
          const values = hashParams.getAll(name).map((item) => sanitizeEvidenceValue(item, name));
          hashParams.delete(name);
          for (const item of values) hashParams.append(name, String(item));
        }
        url.hash = hashParams.toString();
      } else {
        url.hash = SENSITIVE_KEY_PATTERN.test(hashText) ? '***' : sanitizeEvidenceText(hashText);
      }
    }
    return url.toString();
  } catch {
    return sanitizeEvidenceText(value);
  }
}

function headerValue(headers, name) {
  const entry = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name);
  return entry ? String(entry[1]) : '';
}

function decodeUtf8Prefix(buffer, maxBytes) {
  let text = buffer.subarray(0, maxBytes).toString('utf8');
  while (text.endsWith(String.fromCharCode(0xfffd))) text = text.slice(0, -1);
  return text;
}

function fitSerializedString(value, maxBytes) {
  const buffer = Buffer.from(String(value));
  let low = 0;
  let high = Math.min(buffer.length, maxBytes);
  let fitted = '';
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = decodeUtf8Prefix(buffer, middle);
    if (Buffer.byteLength(JSON.stringify(candidate)) <= maxBytes) {
      fitted = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return fitted;
}

function boundedPreview(metadata, value, maxBytes) {
  const buffer = Buffer.from(String(value));
  let low = 0;
  let high = Math.min(buffer.length, maxBytes);
  let result = { ...metadata, preview: '' };
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = { ...metadata, preview: decodeUtf8Prefix(buffer, middle) };
    if (Buffer.byteLength(JSON.stringify(candidate)) <= maxBytes) {
      result = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return result;
}

function isBinaryContentType(contentType) {
  return /^(image|audio|video|font)\\//i.test(contentType)
    || /(?:octet-stream|pdf|zip|gzip|protobuf|woff)/i.test(contentType);
}

function isSafeUtf8Text(buffer) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return false;
  }
  return !buffer.some((byte) => byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d);
}

function containsSensitiveFreeText(value) {
  return /\\b(?:authorization|proxy-authorization|cookie|set-cookie)\\s*[:=]/i.test(value)
    || /\\bBearer\\s+\\S+/i.test(value)
    || /\\b(?:password|passwd|secret|session|token|ticket|credential|access[-_]?token|api[-_]?key|client[-_]?secret)\\b["']?\\s*[:=]/i.test(value);
}

function sanitizeFormFieldValue(value, name) {
  if (SENSITIVE_KEY_PATTERN.test(name)) return '***';
  if (/^[\\s]*[\\[{]/.test(value)) {
    try {
      return sanitizeEvidenceValue(JSON.parse(value));
    } catch {}
  }
  return sanitizeEvidenceValue(value, name);
}

function addFormValue(form, name, value) {
  if (Object.hasOwn(form, name)) {
    form[name] = Array.isArray(form[name]) ? [...form[name], value] : [form[name], value];
  } else {
    form[name] = value;
  }
}

function sanitizeBody(buffer, contentType, maxBytes) {
  if (!buffer || buffer.length === 0) return null;
  if (isBinaryContentType(contentType)) {
    return { contentType, byteLength: buffer.length, omitted: true };
  }
  if (!contentType && !isSafeUtf8Text(buffer)) {
    return {
      contentType,
      byteLength: buffer.length,
      omitted: true,
      reason: 'binary-body-without-content-type',
    };
  }

  const byteLength = buffer.length;
  const prefix = decodeUtf8Prefix(buffer, Math.min(byteLength, 512)).trimStart();
  const hasStructuredMime = /(?:json|application\\/x-www-form-urlencoded|multipart\\/form-data)/i.test(contentType);
  const hasJsonPrefix = /^[\\[{]/.test(prefix);
  const hasUrlEncodedPrefix = /^[^&=\\s]{1,128}=/.test(prefix);
  const isStructured = hasStructuredMime || hasJsonPrefix || hasUrlEncodedPrefix;
  if (isStructured && byteLength > maxBytes) {
    return {
      contentType,
      byteLength,
      truncated: true,
      omitted: true,
      reason: 'structured-body-too-large',
    };
  }
  const text = decodeUtf8Prefix(buffer, maxBytes);
  if (byteLength <= maxBytes && (/json/i.test(contentType) || /^[\\s]*[\\[{]/.test(text))) {
    try {
      const sanitized = sanitizeEvidenceValue(JSON.parse(text));
      const serialized = JSON.stringify(sanitized);
      if (Buffer.byteLength(serialized) <= maxBytes) return sanitized;
      return { contentType, byteLength, truncated: true, omitted: true, reason: 'structured-body-too-large' };
    } catch {}
  }

  if (/multipart\\/form-data/i.test(contentType)) {
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (boundaryMatch && byteLength <= maxBytes) {
      const boundary = boundaryMatch[1] || boundaryMatch[2].trim();
      const form = {};
      let parsedParts = 0;
      for (const part of text.split('--' + boundary)) {
        const separator = part.indexOf('\\r\\n\\r\\n');
        if (separator < 0) continue;
        const partHeaders = part.slice(0, separator);
        const nameMatch = partHeaders.match(/content-disposition:[^\\r\\n]*\\bname=(?:"([^"]+)"|([^;\\r\\n]+))/i);
        if (!nameMatch) continue;
        const name = (nameMatch[1] || nameMatch[2]).trim();
        const rawValue = part.slice(separator + 4).replace(/\\r\\n$/, '');
        const fileMatch = partHeaders.match(/\\bfilename=(?:"([^"]*)"|([^;\\r\\n]+))/i);
        const filenameStarMatch = partHeaders.match(/\\bfilename\\*\\s*=\\s*(?:"([^"]*)"|([^;\\r\\n]+))/i);
        let fileName = fileMatch && (fileMatch[1] || fileMatch[2]);
        if (!fileName && filenameStarMatch) {
          fileName = filenameStarMatch[1] || filenameStarMatch[2];
          fileName = fileName.replace(/^[^']*''/, '');
          try {
            fileName = decodeURIComponent(fileName);
          } catch {}
        }
        const value = fileMatch
          ? {
            fileName: sanitizeEvidenceText(fileName.trim()),
            byteLength: Buffer.byteLength(rawValue),
            omitted: true,
          }
          : filenameStarMatch
            ? {
              fileName: sanitizeEvidenceText(fileName.trim()),
              byteLength: Buffer.byteLength(rawValue),
              omitted: true,
            }
          : sanitizeFormFieldValue(rawValue, name);
        addFormValue(form, name, sanitizeEvidenceValue(value, name));
        parsedParts += 1;
      }
      if (parsedParts > 0) {
        const serialized = JSON.stringify(form);
        if (Buffer.byteLength(serialized) <= maxBytes) return form;
        return { contentType, byteLength, truncated: true, omitted: true, reason: 'structured-body-too-large' };
      }
    }
    return { contentType, byteLength, omitted: true, reason: 'unparseable-multipart' };
  }

  if (byteLength <= maxBytes && /application\\/x-www-form-urlencoded/i.test(contentType)) {
    const form = {};
    for (const [name, formValue] of new URLSearchParams(text)) {
      addFormValue(form, name, sanitizeFormFieldValue(formValue, name));
    }
    const serialized = JSON.stringify(form);
    if (Buffer.byteLength(serialized) <= maxBytes) return form;
    return { contentType, byteLength, truncated: true, omitted: true, reason: 'structured-body-too-large' };
  }

  if (containsSensitiveFreeText(text)) {
    return { contentType, byteLength, omitted: true, reason: 'sensitive-free-text' };
  }
  const sanitizedText = sanitizeEvidenceText(text);
  if (byteLength > maxBytes) {
    return boundedPreview({ contentType, byteLength, truncated: true }, sanitizedText, maxBytes);
  }
  return fitSerializedString(sanitizedText, maxBytes);
}

async function readRequestPayload(request, headers, maxBytes) {
  let buffer = request.postDataBuffer ? request.postDataBuffer() : null;
  if (!buffer) {
    const text = request.postData && request.postData();
    buffer = text == null ? null : Buffer.from(text);
  }
  if (!buffer || buffer.length === 0) return null;
  return sanitizeBody(Buffer.from(buffer), headerValue(headers, 'content-type'), maxBytes);
}

async function readResponsePayload(response, headers, maxBytes) {
  const buffer = await response.body();
  return sanitizeBody(buffer, headerValue(headers, 'content-type'), maxBytes);
}

function businessFailureFromBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const fields = [
    ['errNo', (value) => value !== 0 && value !== '0'],
    ['code', (value) => value !== 0 && value !== '0'],
    ['success', (value) => value === false],
  ];
  const match = fields.find(([field, failed]) => Object.hasOwn(body, field) && failed(body[field]));
  if (!match) return null;
  const [field] = match;
  const message = body.message ?? body.msg ?? body.errorMessage ?? body.error ?? '未知错误';
  return { field, value: body[field], message: sanitizeEvidenceValue(String(message)) };
}

function mergeFailureNetworkRecords(records) {
  const merged = new Map();
  let anonymousSequence = 0;
  for (const record of records || []) {
    if (!record) continue;
    const key = record.requestId || 'anonymous-' + (++anonymousSequence);
    const current = merged.get(key) || {};
    const next = { ...current };
    for (const [field, value] of Object.entries(record)) {
      if (field === 'timestamp') continue;
      if (value !== undefined && value !== null && value !== '') next[field] = value;
    }
    if (!next.requestId && record.requestId) next.requestId = record.requestId;
    const currentTime = Date.parse(current.timestamp || '');
    const recordTime = Date.parse(record.timestamp || '');
    if (Number.isFinite(recordTime)
        && (!Number.isFinite(currentTime) || recordTime > currentTime)) {
      next.timestamp = record.timestamp;
    } else if (!current.timestamp && record.timestamp) {
      next.timestamp = record.timestamp;
    }
    merged.set(key, next);
  }
  return Array.from(merged.values());
}

function selectFailureNetworkEvidence(records, failedStep, limit = 3) {
  const sourceRecords = records instanceof Map
    ? Array.from(records.values())
    : mergeFailureNetworkRecords(records);
  const candidates = sourceRecords.flatMap((record) => {
    if (!record || record.step !== failedStep) return [];
    let weight = 0;
    let kind = '';
    let summary = '';
    if (record.businessFailure) {
      weight = 300;
      kind = 'business';
      const failure = record.businessFailure;
      summary = '业务响应失败：' + failure.field + '='
        + sanitizeEvidenceValue(String(failure.value), failure.field) + '；'
        + sanitizeEvidenceValue(String(failure.message || '未知错误'));
    } else if (record.status >= 400 && record.status <= 599) {
      weight = 200;
      kind = 'http';
      summary = '接口返回 HTTP ' + record.status;
    } else if (record.failure) {
      weight = 100;
      kind = 'requestfailed';
      summary = '请求失败：' + sanitizeEvidenceValue(String(record.failure.errorText || 'unknown'));
    }
    if (!weight) return [];
    return [{
      weight,
      timestamp: Date.parse(record.timestamp || '') || 0,
      evidence: {
        requestId: record.requestId,
        step: record.step,
        method: record.method,
        url: sanitizeUrl(record.url),
        status: record.status ?? null,
        traceId: record.traceId || '',
        kind,
        summary,
      },
    }];
  });

  return candidates
    .sort((left, right) => right.weight - left.weight || right.timestamp - left.timestamp)
    .slice(0, Math.min(3, Math.max(0, limit)))
    .map(({ evidence }) => evidence);
}

function createNetworkEvidenceCollector(ctx, options = {}) {
  const logFile = path.join(ctx.artifactDir, 'network-events.ndjson');
  const requestIds = new WeakMap();
  const records = new Map();
  const pending = new Set();
  const openRequestIds = new Set();
  const incompleteReasons = new Set();
  const attachedContexts = new WeakSet();
  const listenerRegistrations = [];
  const requestedBodyBytes = Number(options.maxBodyBytes);
  const maxBodyBytes = Math.min(
    MAX_NETWORK_BODY_BYTES,
    Number.isFinite(requestedBodyBytes) && requestedBodyBytes > 0 ? requestedBodyBytes : MAX_NETWORK_BODY_BYTES,
  );
  const flushTimeoutMs = options.flushTimeoutMs ?? 100;
  const now = options.now || (() => new Date().toISOString());
  let sequence = 0;
  let captureError = '';
  let acceptingEvents = true;
  let flushPromise = null;

  function recordCaptureError(error) {
    if (!acceptingEvents) return;
    if (captureError) return;
    const reason = String(error && error.name || 'Error').replace(/[^A-Za-z0-9_.-]/g, '') || 'Error';
    captureError = '网络证据采集失败：' + reason;
  }

  function requestRecord(request) {
    try {
      if (!NETWORK_RESOURCE_TYPES.has(request.resourceType())) return null;
      let requestId = requestIds.get(request);
      if (!requestId) {
        requestId = 'req-' + (++sequence);
        requestIds.set(request, requestId);
      }
      let record = records.get(requestId);
      if (!record) {
        record = {
          requestId,
          step: ctx.result.currentStep || 'startup',
          method: request.method(),
          url: sanitizeUrl(request.url()),
          resourceType: request.resourceType(),
          status: null,
          traceId: '',
          timestamp: now(),
        };
        records.set(requestId, record);
      }
      return record;
    } catch (error) {
      recordCaptureError(error);
      return null;
    }
  }

  function appendEvent(event) {
    if (!acceptingEvents) return;
    try {
      ensureDir(ctx.artifactDir);
      const sanitizedEvent = sanitizeEvidenceValue(event);
      if (event.event === 'response' && Object.hasOwn(event, 'traceId')) {
        sanitizedEvent.traceId = String(event.traceId);
        const traceEntry = Object.entries(event.headers || {})
          .find(([name]) => name.toLowerCase() === 'x-trace-id');
        if (traceEntry) sanitizedEvent.headers[traceEntry[0]] = String(traceEntry[1]);
      }
      fs.appendFileSync(logFile, JSON.stringify(sanitizedEvent) + '\\n');
    } catch (error) {
      recordCaptureError(error);
    }
  }

  function schedule(work) {
    if (!acceptingEvents) return;
    const task = Promise.resolve().then(work).catch((error) => {
      if (acceptingEvents) recordCaptureError(error);
    });
    pending.add(task);
    task.finally(() => pending.delete(task));
  }

  function registerListener(context, event, handler) {
    context.on(event, handler);
    listenerRegistrations.push({ context, event, handler });
  }

  function freezeCollection() {
    acceptingEvents = false;
    for (const { context, event, handler } of listenerRegistrations.splice(0)) {
      if (typeof context.off === 'function') context.off(event, handler);
      else if (typeof context.removeListener === 'function') context.removeListener(event, handler);
    }
  }

  function attach(context) {
    if (!acceptingEvents || !context || typeof context.on !== 'function' || attachedContexts.has(context)) return;
    attachedContexts.add(context);

    registerListener(context, 'request', (request) => {
      if (!acceptingEvents) return;
      const record = requestRecord(request);
      if (!record) return;
      openRequestIds.add(record.requestId);
      schedule(async () => {
        const headers = sanitizeEvidenceValue(await request.allHeaders());
        if (!acceptingEvents) return;
        const body = await readRequestPayload(request, headers, maxBodyBytes);
        if (!acceptingEvents) return;
        appendEvent({
          event: 'request',
          requestId: record.requestId,
          timestamp: record.timestamp,
          step: record.step,
          method: record.method,
          url: record.url,
          resourceType: record.resourceType,
          headers,
          body,
        });
      });
    });

    registerListener(context, 'response', (response) => {
      if (!acceptingEvents) return;
      let request;
      try {
        request = response.request();
      } catch (error) {
        recordCaptureError(error);
        return;
      }
      const record = requestRecord(request);
      if (!record) return;
      openRequestIds.delete(record.requestId);
      schedule(async () => {
        if (!acceptingEvents) return;
        record.status = response.status();
        const headers = sanitizeResponseHeaders(await response.allHeaders());
        if (!acceptingEvents) return;
        record.traceId = extractTraceId(headers);
        record.timestamp = now();
        let body;
        try {
          body = await readResponsePayload(response, headers, maxBodyBytes);
        } catch (error) {
          if (!acceptingEvents) return;
          const errorName = String(error && error.name || 'Error').replace(/[^A-Za-z0-9_.-]/g, '') || 'Error';
          body = {
            contentType: headerValue(headers, 'content-type'),
            omitted: true,
            reason: 'read-error',
            error: errorName,
          };
          incompleteReasons.add('响应正文读取失败：' + record.requestId);
        }
        if (!acceptingEvents) return;
        record.businessFailure = businessFailureFromBody(body);
        appendEvent({
          event: 'response',
          requestId: record.requestId,
          timestamp: record.timestamp,
          step: record.step,
          method: record.method,
          url: record.url,
          resourceType: record.resourceType,
          status: record.status,
          traceId: record.traceId,
          headers,
          body,
        });
      });
    });

    registerListener(context, 'requestfailed', (request) => {
      if (!acceptingEvents) return;
      const record = requestRecord(request);
      if (!record) return;
      openRequestIds.delete(record.requestId);
      schedule(async () => {
        if (!acceptingEvents) return;
        const failure = request.failure ? request.failure() : null;
        record.failure = { errorText: sanitizeEvidenceValue(String(failure && failure.errorText || 'unknown')) };
        record.timestamp = now();
        appendEvent({
          event: 'requestfailed',
          requestId: record.requestId,
          timestamp: record.timestamp,
          step: record.step,
          method: record.method,
          url: record.url,
          resourceType: record.resourceType,
          failure: record.failure,
        });
      });
    });
  }

  function flush() {
    if (flushPromise) return flushPromise;
    flushPromise = (async () => {
      const deadline = Date.now() + Math.max(0, flushTimeoutMs);
      while ((pending.size || openRequestIds.size) && Date.now() < deadline) {
        const remaining = Math.max(0, deadline - Date.now());
        const snapshot = Array.from(pending);
        await new Promise((resolve) => {
          let timer;
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          };
          timer = setTimeout(finish, Math.min(5, remaining));
          if (snapshot.length) Promise.allSettled(snapshot).then(finish);
        });
      }
      if (pending.size) incompleteReasons.add('网络证据异步任务在结束时未完成：' + pending.size);
      for (const requestId of openRequestIds) {
        incompleteReasons.add('请求在采集结束时仍未完成：' + requestId);
      }
      freezeCollection();
      pending.clear();
    })();
    return flushPromise;
  }

  function summary(failedStep) {
    const failureCandidates = selectFailureNetworkEvidence(records, failedStep, 3);
    const missingEvidence = Array.from(incompleteReasons);
    if (captureError) missingEvidence.push(captureError);
    if (failedStep && failureCandidates.length === 0) {
      missingEvidence.push('未采集到与失败步骤 ' + failedStep + ' 相关的失败请求');
    }
    return {
      captureStatus: captureError || incompleteReasons.size ? 'incomplete' : 'complete',
      logFile,
      totalRequests: records.size,
      failureCandidates,
      missingEvidence,
    };
  }

  return { attach, flush, summary, logFile };
}

function firstLine(value) {
  return String(value || '').split('\\n')[0];
}

function stepStatus(name, result) {
  if ((result.completedSteps || []).includes(name)) return '成功';
  if (result.failedStep === name) return '失败';
  return '未开始';
}

function mappingEntryLabel(entry) {
  const key = entry.key || entry.arg || entry.id || entry.route || entry.url || 'unknown';
  const zh = entry.zhName || entry.zh || entry.cn || '未填写中文名';
  const en = entry.enName || entry.en || 'Missing English name';
  const source = entry.frontendSource ? ' @ ' + entry.frontendSource : '';
  return key + ': ' + zh + ' / ' + en + source;
}

function printCaseContextMapping(mapping) {
  console.log('');
  console.log('中英文映射:');
  const sections = [
    ['inputs', '入参'],
    ['reportFields', '报告字段'],
    ['features', '功能'],
    ['nodes', '节点'],
    ['scenes', '场景'],
    ['endpoints', '接口'],
  ];

  for (const [name, title] of sections) {
    const items = Array.isArray(mapping && mapping[name]) ? mapping[name] : [];
    console.log('- ' + title + ': ' + items.length);
    for (const item of items.slice(0, 8)) {
      console.log('  - ' + mappingEntryLabel(item));
    }
  }
}

function printExecutionReport(ctx) {
  const result = ctx.result;
  console.log('');
  console.log('========== E2E 执行报告 ==========');
  console.log('结果: ' + (result.ok ? '成功' : '失败'));
  console.log('结果文件: ' + ctx.resultFile);
  console.log('Base URL: ' + ctx.args.baseUrl);
  console.log('');
  console.log('步骤明细:');
  for (const [name, title] of STEP_REPORTS) {
    console.log('- [' + stepStatus(name, result) + '] ' + name + ' - ' + title);
  }
  printCaseContextMapping(result.caseContextMapping);
  if (result.failedStep) console.log('失败步骤: ' + result.failedStep);
  if (result.error) console.log('错误摘要: ' + firstLine(result.error));
  if (result.screenshot) console.log('失败截图: ' + result.screenshot);
  console.log('==================================');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
}

function exactLabelPattern(label) {
  return new RegExp(\`^\\\\s*\${escapeRegExp(label)}\\\\s*$\`);
}

async function clickLocatorCenter(locator, options = {}) {
  await locator.waitFor({ state: 'visible', timeout: options.timeout ?? 10_000 });
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error(\`No bounding box for \${options.name ?? 'locator'}\`);
  await locator.page().mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function visibleTexts(locator) {
  const count = await locator.count();
  const texts = [];
  for (let i = 0; i < count; i += 1) {
    const item = locator.nth(i);
    if (await item.isVisible().catch(() => false)) {
      const text = (await item.innerText().catch(() => '')).trim();
      if (text) texts.push(text);
    }
  }
  return texts;
}

async function latestVisible(page, selector, name, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  do {
    const locator = page.locator(selector);
    const count = await locator.count();
    for (let i = count - 1; i >= 0; i -= 1) {
      const item = locator.nth(i);
      if (await item.isVisible().catch(() => false)) return item;
    }
    if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error(\`No visible \${name ?? selector}\`);
}

async function selectElementPlusOption(page, fieldRoot, label, options = {}) {
  await clickLocatorCenter(fieldRoot, { name: options.name ?? \`select \${label}\` });
  const popper = await latestVisible(page, '.el-select__popper, .el-popper', 'select popper');
  const items = popper.locator('.el-select-dropdown__item');
  const option = items.filter({ hasText: exactLabelPattern(label) }).first();

  if (!(await option.isVisible().catch(() => false))) {
    const available = await visibleTexts(items);
    throw new Error(\`Option "\${label}" not found. Available: [\${available.join(', ')}]\`);
  }

  await clickLocatorCenter(option, { name: \`option \${label}\` });
  await popper.waitFor({ state: 'hidden', timeout: options.closeTimeout ?? 3_000 }).catch(async () => {
    await page.keyboard.press('Escape');
    await popper.waitFor({ state: 'hidden', timeout: 2_000 }).catch(() => {});
  });
}

function executionStage(name) {
  return E2E_EXECUTION_CONTRACT.stages.find((stage) => stage.key === name) || null;
}

function validateExecutionContract() {
  const stages = E2E_EXECUTION_CONTRACT.stages;
  const mutationIndexes = stages
    .map((stage, index) => (stage.mode === 'mutation' ? index : -1))
    .filter((index) => index >= 0);
  const firstMutation = mutationIndexes.length ? mutationIndexes[0] : -1;
  const lastMutation = mutationIndexes.length ? mutationIndexes[mutationIndexes.length - 1] : -1;
  const preflightIndex = stages.findIndex((stage) => stage.mode === 'preflight');
  const assertionIndex = stages.findLastIndex((stage) => stage.mode === 'assertion' && stage.observable === true);

  if (E2E_EXECUTION_CONTRACT.schemaVersion !== 2) throw new Error('Unsupported execution contract schema');
  if (!Array.isArray(E2E_EXECUTION_CONTRACT.stabilityRules)) throw new Error('Execution contract stabilityRules must be an array');
  if (preflightIndex < 0 || (firstMutation >= 0 && preflightIndex >= firstMutation)) {
    throw new Error('Execution contract must place preflight before mutation');
  }
  if (lastMutation >= 0 && assertionIndex <= lastMutation) {
    throw new Error('Execution contract must place an observable assertion after mutation');
  }
  for (const stage of stages) {
    if (stage.mode === 'mutation' && stage.irreversible && !stage.checkpointKey) {
      throw new Error(\`Irreversible stage \"\${stage.key}\" must declare checkpointKey\`);
    }
  }
}

function writeStabilityGate(ctx) {
  if (!ctx.stabilityGateFile || !ctx.result.stabilityGate) return;
  writeJson(ctx.stabilityGateFile, sanitizeEvidenceValue(ctx.result.stabilityGate));
}

function recordPreflightEvidence(ctx, evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) || Object.keys(evidence).length === 0) {
    throw new Error('Preflight must record non-empty evidence');
  }
  ctx.result.preflightEvidence = sanitizeEvidenceValue(evidence);
  writeJson(ctx.resultFile, ctx.result);
}

function recordAssertionEvidence(ctx, stageKey, evidence) {
  const stage = executionStage(stageKey);
  if (!stage || stage.mode !== 'assertion' || stage.observable !== true) {
    throw new Error(\`Stage \"\${stageKey}\" is not an observable assertion\`);
  }
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) || Object.keys(evidence).length === 0) {
    throw new Error(\`Assertion \"\${stageKey}\" requires non-empty evidence\`);
  }
  ctx.result.assertionEvidence ||= {};
  ctx.result.assertionEvidence[stageKey] = sanitizeEvidenceValue(evidence);
  writeJson(ctx.resultFile, ctx.result);
}

function nonEmptyEvidence(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0);
}

function stabilityRuleOutcomeValid(entry) {
  if (!entry || !nonEmptyEvidence(entry.evidence)) return false;
  if (entry.status === 'applied') return entry.evidence.verified === true
    && entry.evidence.observedAtRuntime === true
    && typeof entry.evidence.observation === 'string'
    && entry.evidence.observation.trim().length > 0;
  return entry.status === 'expired'
    && entry.evidence.observedAtRuntime === true
    && typeof entry.evidence.observation === 'string'
    && entry.evidence.observation.trim().length > 0
    && entry.replacement?.status === 'applied'
    && typeof entry.replacement?.rule === 'string'
    && entry.replacement.rule.trim().length > 0
    && nonEmptyEvidence(entry.replacement.evidence)
    && entry.replacement.evidence.verified === true
    && typeof entry.replacement.evidence.observation === 'string'
    && entry.replacement.evidence.observation.trim().length > 0;
}

function updateStabilityRuleSummary(ctx) {
  const rules = ctx.result.stabilityGate?.rules || [];
  ctx.result.stabilityGate.ruleSummary = {
    total: rules.length,
    applied: rules.filter((rule) => rule.status === 'applied').length,
    expired: rules.filter((rule) => rule.status === 'expired').length,
    replacements: rules.filter((rule) => rule.status === 'expired' && rule.replacement?.status === 'applied').length,
    incomplete: rules.filter((rule) => !stabilityRuleOutcomeValid(rule)).length,
  };
}

function recordStabilityRule(ctx, ruleId, outcome) {
  const declared = E2E_EXECUTION_CONTRACT.stabilityRules.find((rule) => rule.id === ruleId);
  if (!declared) throw new Error(\`Unknown or inapplicable stability rule "\${ruleId}"\`);
  const active = ACTIVE_STABILITY_STAGES.get(ctx);
  if (!active) throw new Error(\`Stability rule "\${ruleId}" can only be recorded inside an active runStep callback\`);
  if (!ctx.page || typeof ctx.page.isClosed !== 'function' || ctx.page.isClosed() || typeof ctx.page.context !== 'function') {
    throw new Error(\`Stability rule "\${ruleId}" requires a live Playwright page\`);
  }
  const firstMutation = E2E_EXECUTION_CONTRACT.stages.findIndex((stage) => stage.mode === 'mutation');
  const finalAssertion = E2E_EXECUTION_CONTRACT.stages.findLastIndex(
    (stage) => stage.mode === 'assertion' && stage.observable === true,
  );
  const beforeCutoff = declared.requiredBefore === 'mutation'
    ? ['preflight', 'read-only'].includes(active.stage.mode)
      && (firstMutation < 0 || active.stageIndex < firstMutation)
    : finalAssertion >= 0 && active.stageIndex <= finalAssertion;
  if (!beforeCutoff) throw new Error(\`Stability rule "\${ruleId}" was recorded after its \${declared.requiredBefore} cutoff\`);
  if (!outcome || !['applied', 'expired'].includes(outcome.status)) {
    throw new Error(\`Stability rule "\${ruleId}" outcome must be applied or expired\`);
  }
  if (!nonEmptyEvidence(outcome.evidence)) {
    throw new Error(\`Stability rule "\${ruleId}" requires non-empty runtime evidence\`);
  }
  if (outcome.status === 'applied' && outcome.evidence.verified !== true) {
    throw new Error(\`Applied stability rule "\${ruleId}" evidence must set verified: true\`);
  }
  if (outcome.status === 'applied' && (typeof outcome.evidence.observation !== 'string' || !outcome.evidence.observation.trim())) {
    throw new Error(\`Applied stability rule "\${ruleId}" evidence requires a non-empty observation\`);
  }
  if (outcome.status === 'expired' && (
    typeof outcome.evidence.observation !== 'string'
    || !outcome.evidence.observation.trim()
  )) {
    throw new Error(\`Expired stability rule "\${ruleId}" requires a non-empty runtime observation\`);
  }
  if (outcome.status === 'expired' && (
    outcome.replacement?.status !== 'applied'
    || typeof outcome.replacement?.rule !== 'string'
    || !outcome.replacement.rule.trim()
    || !nonEmptyEvidence(outcome.replacement.evidence)
    || outcome.replacement.evidence.verified !== true
    || typeof outcome.replacement.evidence.observation !== 'string'
    || !outcome.replacement.evidence.observation.trim()
  )) {
    throw new Error(\`Expired stability rule "\${ruleId}" requires a replacement rule with successful replacement evidence\`);
  }
  const rules = ctx.result.stabilityGate?.rules;
  const index = Array.isArray(rules) ? rules.findIndex((rule) => rule.id === ruleId) : -1;
  if (index < 0) throw new Error(\`Stability gate did not initialize rule "\${ruleId}"\`);
  const observedAt = new Date().toISOString();
  const runtimeStamp = {
    observedAtRuntime: true,
    observedAt,
    stage: active.stage.key,
    stageMode: active.stage.mode,
  };
  rules[index] = {
    ...rules[index],
    status: outcome.status,
    evidence: { ...sanitizeEvidenceValue(outcome.evidence), ...runtimeStamp },
    recordedAt: observedAt,
    ...(outcome.status === 'expired' ? {
      replacement: {
        ...sanitizeEvidenceValue(outcome.replacement),
        evidence: { ...sanitizeEvidenceValue(outcome.replacement.evidence), ...runtimeStamp },
      },
    } : {}),
  };
  updateStabilityRuleSummary(ctx);
  writeStabilityGate(ctx);
  writeJson(ctx.resultFile, ctx.result);
  return rules[index];
}

function assertStabilityRulesResolved(ctx, phase) {
  const declared = E2E_EXECUTION_CONTRACT.stabilityRules.filter(
    (rule) => phase === 'certification' || rule.requiredBefore === 'mutation',
  );
  const recorded = ctx.result.stabilityGate?.rules || [];
  const unresolved = declared.filter((rule) => {
    const entry = recorded.find((candidate) => candidate.id === rule.id);
    return !stabilityRuleOutcomeValid(entry);
  });
  if (unresolved.length > 0) {
    throw new Error(\`Unresolved stability rules block \${phase}: \${unresolved.map((rule) => rule.id).join(', ')}\`);
  }
}

function persistCheckpoint(ctx, stageKey, data) {
  const stage = executionStage(stageKey);
  if (!stage || stage.mode !== 'mutation' || !stage.checkpointKey) {
    throw new Error(\`Stage \"\${stageKey}\" does not declare checkpoint metadata\`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length === 0) {
    throw new Error(\`Checkpoint \"\${stage.checkpointKey}\" requires non-empty recovery data\`);
  }

  const entry = {
    stageKey,
    checkpointKey: stage.checkpointKey,
    recordedAt: new Date().toISOString(),
    context: sanitizeEvidenceValue(ctx.result.verifiedContext || {}),
    data: sanitizeEvidenceValue(data),
  };
  ctx.result.checkpoints ||= {};
  ctx.result.checkpoints[stage.checkpointKey] = entry;
  if (ctx.checkpointFile) {
    writeJson(ctx.checkpointFile, {
      schemaVersion: 1,
      case: ctx.result.case,
      checkpoints: ctx.result.checkpoints,
    });
  }
  writeJson(ctx.resultFile, ctx.result);
  return entry;
}

function assertRuntimeStageGate(ctx, name) {
  if (!ctx.result.stabilityGate) return;
  const stage = executionStage(name);
  if (!stage) throw new Error(\`Stage \"\${name}\" is missing from E2E_EXECUTION_CONTRACT\`);
  if (stage.mode === 'mutation' && ctx.result.stabilityGate.preflight?.status !== 'passed') {
    throw new Error(\`Mutation stage \"\${name}\" is blocked until preflight passes\`);
  }
  if (stage.mode === 'mutation') assertStabilityRulesResolved(ctx, 'mutation');
}

async function runStep(ctx, name, fn) {
  assertRuntimeStageGate(ctx, name);
  const stage = executionStage(name);
  const startedAt = new Date();
  ctx.result.stepTimings ||= {};
  ctx.result.stepTimings[name] = {
    startedAt: startedAt.toISOString(),
    status: '执行中',
  };
  ctx.result.currentStep = name;
  writeJson(ctx.resultFile, ctx.result);
  console.log(\`[step] \${name}\`);

  try {
    const previousActiveStage = ACTIVE_STABILITY_STAGES.get(ctx);
    ACTIVE_STABILITY_STAGES.set(ctx, {
      stage,
      stageIndex: E2E_EXECUTION_CONTRACT.stages.findIndex((candidate) => candidate.key === name),
    });
    try {
      await fn();
    } finally {
      if (previousActiveStage) ACTIVE_STABILITY_STAGES.set(ctx, previousActiveStage);
      else ACTIVE_STABILITY_STAGES.delete(ctx);
    }
    if (ctx.result.stabilityGate && stage?.mode === 'preflight') {
      if (!ctx.result.preflightEvidence || Object.keys(ctx.result.preflightEvidence).length === 0) {
        throw new Error('Preflight completed without recorded evidence');
      }
      assertStabilityRulesResolved(ctx, 'mutation');
      ctx.result.stabilityGate.preflight = {
        status: 'passed',
        stage: name,
        evidence: ctx.result.preflightEvidence,
        finishedAt: new Date().toISOString(),
      };
      ctx.result.stabilityGate.mutationUnlocked = true;
      ctx.result.stabilityGate.status = 'preflight-passed';
      writeStabilityGate(ctx);
    }
    if (ctx.result.stabilityGate && stage?.mode === 'mutation' && stage.irreversible) {
      const checkpoint = ctx.result.checkpoints?.[stage.checkpointKey];
      if (!checkpoint || checkpoint.stageKey !== name) {
        throw new Error(\`Irreversible stage \"\${name}\" must persist checkpoint \"\${stage.checkpointKey}\" before completion\`);
      }
    }
    if (ctx.result.stabilityGate && stage?.mode === 'assertion') {
      const assertionEvidence = ctx.result.assertionEvidence?.[name];
      if (!assertionEvidence || Object.keys(assertionEvidence).length === 0) {
        throw new Error(\`Assertion stage \"\${name}\" must record observable assertion evidence before completion\`);
      }
      assertStabilityRulesResolved(ctx, 'certification');
      ctx.result.stabilityGate.status = 'passed';
      ctx.result.stabilityGate.finalAssertion = {
        status: 'passed',
        stage: name,
        evidence: assertionEvidence,
        finishedAt: new Date().toISOString(),
      };
      writeStabilityGate(ctx);
    }
    ctx.result.completedSteps.push(name);
    const finishedAt = new Date();
    ctx.result.stepTimings[name] = {
      ...ctx.result.stepTimings[name],
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      status: '成功',
    };
    writeJson(ctx.resultFile, ctx.result);
  } catch (error) {
    if (ctx.result.stabilityGate && stage?.mode === 'preflight') {
      ctx.result.stabilityGate.preflight = {
        status: 'failed',
        stage: name,
        finishedAt: new Date().toISOString(),
        error: firstLine(error && (error.stack || error.message) ? (error.stack || error.message) : error),
      };
      ctx.result.stabilityGate.mutationUnlocked = false;
      ctx.result.stabilityGate.status = 'failed';
      writeStabilityGate(ctx);
    }
    const screenshot = path.join(ctx.artifactDir, \`\${Date.now()}-\${name.replace(/[^a-z0-9_-]+/gi, '-')}.png\`);
    if (ctx.page && !ctx.page.isClosed()) {
      await ctx.page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
      ctx.result.url = ctx.page.url();
    }
    ctx.result.failedStep = name;
    ctx.result.error = String(error && error.stack ? error.stack : error);
    ctx.result.screenshot = screenshot;
    const finishedAt = new Date();
    ctx.result.stepTimings[name] = {
      ...ctx.result.stepTimings[name],
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      status: '失败',
    };
    writeJson(ctx.resultFile, ctx.result);
    throw error;
  }
}

async function applyCookie(context, cookieText, baseUrl) {
  if (!cookieText) return;
  const url = new URL(baseUrl);
  const cookies = cookieText.split(';').map((part) => {
    const [name, ...rest] = part.trim().split('=');
    return {
      name,
      value: rest.join('='),
      domain: url.hostname,
      path: '/',
      httpOnly: false,
      secure: url.protocol === 'https:',
      sameSite: 'Lax',
    };
  }).filter((cookie) => cookie.name && cookie.value);
  if (cookies.length) await context.addCookies(cookies);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const caseDir = path.dirname(path.resolve(process.argv[1]));
  const usesDefaultArtifactDir = !args.artifactDir;
  args.artifactDir = args.artifactDir || path.join(caseDir, 'artifacts');
  ensureDir(args.artifactDir);
  const resultFile = path.join(usesDefaultArtifactDir ? caseDir : args.artifactDir, 'result.json');
  const checkpointFile = path.join(args.artifactDir, 'checkpoint.json');
  const stabilityGateFile = path.join(args.artifactDir, 'stability-gate.json');
  const ctx = {
    args,
    browser: null,
    context: null,
    page: null,
    networkCollector: null,
    pendingVideoArtifacts: [],
    artifactDir: args.artifactDir,
    resultFile,
    checkpointFile,
    stabilityGateFile,
    result: {
      case: ${jsString(caseTitle)},
      casePath: ${jsString(casePath)},
      startedAt: new Date().toISOString(),
      completedSteps: [],
      stepTimings: {},
      checkpoints: {},
      assertionEvidence: {},
      videoRecording: {
        enabled: args.recordVideo,
        directory: path.join(args.artifactDir, 'videos'),
        artifacts: [],
      },
      stepArtifacts: {},
      stepReports: STEP_REPORTS,
      caseResults: CASE_CATALOG.map((item) => ({
        ...item,
        stepKeys: Object.entries(STEP_CASE_MAP)
          .filter(([, caseIds]) => caseIds.includes(item.caseId))
          .map(([step]) => step),
      })),
      stepCaseMap: STEP_CASE_MAP,
      caseContextMapping: CASE_CONTEXT_MAPPING,
      executionContract: E2E_EXECUTION_CONTRACT,
      stabilityGate: {
        schemaVersion: 2,
        file: stabilityGateFile,
        status: 'pending',
        dryRun: { status: 'not-run' },
        preflight: { status: 'not-run' },
        mutationUnlocked: false,
        rules: E2E_EXECUTION_CONTRACT.stabilityRules.map((rule) => ({
          id: rule.id,
          category: rule.category,
          requiredBefore: rule.requiredBefore,
          status: 'active',
        })),
      },
    },
  };

  writeJson(resultFile, ctx.result);
  let runError = null;
  try {
    ctx.result.currentStep = 'startup';
    validateExecutionContract();
    if (args.dryRun) {
      ctx.result.mode = 'dry-run';
      ctx.result.stabilityGate.dryRun = {
        status: 'passed',
        finishedAt: new Date().toISOString(),
      };
      ctx.result.stabilityGate.status = 'dry-run-passed';
      ctx.result.finishedAt = new Date().toISOString();
      ctx.result.ok = true;
      writeStabilityGate(ctx);
      writeJson(resultFile, ctx.result);
      return;
    }
    writeJson(resultFile, ctx.result);
    const playwrightRuntime = loadPlaywrightRuntime({
      cwd: process.cwd(),
      scriptDir: caseDir,
    });
    const { chromium } = playwrightRuntime.playwright;
    ctx.result.playwrightRuntime = { resolvedFrom: playwrightRuntime.resolvedFrom };
    writeJson(resultFile, ctx.result);

    ctx.browser = await chromium.launch({
      headless: !args.headed,
      slowMo: args.headed ? 80 : 0,
    });

    ctx.context = await ctx.browser.newContext(buildBrowserContextOptions(args, {
      viewport: { width: 1280, height: 900 },
      storageState: args.storageState,
    }));
    ctx.networkCollector = createNetworkEvidenceCollector(ctx);
    ctx.networkCollector.attach(ctx.context);
    ctx.result.networkEvidence = {
      captureStatus: 'collecting',
      logFile: ctx.networkCollector.logFile,
      totalRequests: 0,
      failureCandidates: [],
      missingEvidence: [],
    };
    writeJson(resultFile, ctx.result);
    await applyCookie(ctx.context, args.cookie, args.baseUrl);

    ctx.page = await ctx.context.newPage();
    trackPageVideo(ctx, ctx.page, { role: '主页面', step: 'test-flow', context: 'browser' });

    await runStep(ctx, 'preflight', async () => {
      await ctx.page.goto(args.baseUrl, { waitUntil: 'domcontentloaded' });
      await ctx.page.waitForLoadState('networkidle').catch(() => {});
      // TODO(case): Verify authentication, global context, configuration, inputs, and dependent records.
      recordPreflightEvidence(ctx, {
        environment: args.baseUrl,
        authentication: 'TODO(case): visible authenticated identity',
        globalContext: 'TODO(case): verified tenant, school, campus, or equivalent scope',
        dependencies: 'TODO(case): uniquely identified required records and configuration',
      });
${mutationRuleCalls}
    });

    if (args.preflightOnly) {
      ctx.result.mode = 'preflight-only';
      ctx.result.finishedAt = new Date().toISOString();
      ctx.result.ok = true;
      writeStabilityGate(ctx);
      writeJson(resultFile, ctx.result);
      return;
    }

    await runStep(ctx, 'case-action', async () => {
      // TODO(case): Replace this block with concrete actions from the case.
      // Example:
      // await page.getByRole('button', { name: '新建' }).click();
      // await selectElementPlusOption(page, page.locator('.el-select').first(), '高意向');
      // await page.getByRole('button', { name: '提交' }).click();
      // Persist immediately after the UI-triggered mutation succeeds:
      // persistCheckpoint(ctx, 'case-action', { recordId: observedResponse.data.id });
    });

    await runStep(ctx, 'assert-result', async () => {
      // TODO(case): Add the final business assertion.
      // Example: await page.getByText('提交成功').waitFor({ state: 'visible' });
      // recordAssertionEvidence(ctx, 'assert-result', { visibleStatus: '提交成功' });
${certificationRuleCalls}
    });

    assertStabilityRulesResolved(ctx, 'certification');
    ctx.result.stabilityGate.status = 'passed';
    updateStabilityRuleSummary(ctx);
    ctx.result.finishedAt = new Date().toISOString();
    ctx.result.ok = true;
    writeJson(resultFile, ctx.result);
  } catch (error) {
    runError = error;
    ctx.result.finishedAt = new Date().toISOString();
    ctx.result.ok = false;
    if (!ctx.result.failedStep) {
      ctx.result.failedStep = ctx.result.currentStep || 'startup';
      ctx.result.error = String(error && error.stack ? error.stack : error);
    }
    writeJson(resultFile, ctx.result);
  } finally {
    if (ctx.networkCollector) {
      await ctx.networkCollector.flush().catch(() => {});
      ctx.result.networkEvidence = ctx.networkCollector.summary(ctx.result.failedStep);
      writeJson(resultFile, ctx.result);
    }
    if (ctx.context) await ctx.context.close().catch(() => {});
    await finalizeVideoArtifacts(ctx);
    printExecutionReport(ctx);
    if (ctx.browser) await ctx.browser.close().catch(() => {});
  }
  if (runError) throw runError;
}

module.exports = {
  STEP_REPORTS,
  CASE_CONTEXT_MAPPING,
  E2E_EXECUTION_CONTRACT,
  CASE_HANDOFF,
  AUTOMATION_MODULE_DEPENDENCIES,
  CASE_CATALOG,
  STEP_CASE_MAP,
  loadPlaywrightRuntime,
  latestVisible,
  runStep,
  persistCheckpoint,
  recordPreflightEvidence,
  recordAssertionEvidence,
  recordStabilityRule,
  assertStabilityRulesResolved,
  writeStabilityGate,
  createNetworkEvidenceCollector,
  buildBrowserContextOptions,
  trackPageVideo,
  finalizeVideoArtifacts,
  sanitizeEvidenceValue,
  extractTraceId,
  selectFailureNetworkEvidence,
};

if (require.main === module) {
  main().catch((error) => {
    console.error('[error] ' + firstLine(error && (error.stack || error.message) ? (error.stack || error.message) : error));
    process.exitCode = 1;
  });
}
`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const handoffRecord = loadHandoff(args.handoff, args.caseName);
  const workspace = fs.realpathSync(process.cwd());
  const canonicalOut = path.resolve(defaultOutputPath(args.caseName, handoffRecord?.value));
  const out = path.resolve(args.out || canonicalOut);
  // devflow: 允许 --out 指向 worktree/<需求名>/docs/e2e/script.js
  const outDir = path.dirname(out);
  const canonicalDir = path.dirname(canonicalOut);
  const outBasename = path.basename(out);
  if (out !== canonicalOut && !(outBasename === 'script.js' && outDir.startsWith(path.resolve(process.cwd(), 'worktree')) && outDir.endsWith('/docs/e2e'))) {
    throw new Error(`--out must equal the canonical Case script path: ${canonicalOut}`);
  }
  // 确保输出目录存在
  fs.mkdirSync(outDir, { recursive: true });

  const caseId = handoffRecord?.value?.caseId || path.basename(path.dirname(out));
  const caseDefinition = readCaseDefinition(args.caseName, caseId);
  const automationModuleInfo = createAutomationModuleImports(handoffRecord, out);
  const content = template({
    caseName: args.caseName,
    caseTitle: caseDefinition.title,
    casePath: caseDefinition.path,
    caseSummary: caseDefinition.summary,
    caseCatalog: caseDefinition.catalog,
    baseUrl: args.baseUrl,
    handoff: handoffRecord ? handoffRecord.value : null,
    automationModuleImports: automationModuleInfo.imports,
    automationModuleDependencies: automationModuleInfo.dependencies,
  });

  prepareCanonicalOutputPath(workspace, out);
  writeCanonicalScript(out, content);
  console.log(`Created ${out}`);
}

main();
