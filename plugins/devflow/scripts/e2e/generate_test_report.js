#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

function parseArgs(argv) {
  const args = {
    description: '',
    title: '',
    script: '',
    command: '',
    resultJson: [],
    caseIds: [],
    failureAnalysis: '',
    manifest: '',
    log: '',
    outDir: '',
    htmlOnly: true,
    styleSourceHtml: '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const readValue = () => {
      if (arg.includes('=')) return arg.slice(arg.indexOf('=') + 1);
      i += 1;
      if (i >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[i];
    };

    if (arg === '--description' || arg.startsWith('--description=')) args.description = readValue();
    else if (arg === '--title' || arg.startsWith('--title=')) args.title = readValue();
    else if (arg === '--script' || arg.startsWith('--script=')) args.script = readValue();
    else if (arg === '--command' || arg.startsWith('--command=')) args.command = readValue();
    else if (arg === '--result-json' || arg.startsWith('--result-json=')) args.resultJson.push(readValue());
    else if (arg === '--case-ids' || arg.startsWith('--case-ids=')) args.caseIds = readValue().split(',').map((value) => value.trim()).filter(Boolean);
    else if (arg === '--failure-analysis' || arg.startsWith('--failure-analysis=')) args.failureAnalysis = readValue();
    else if (arg === '--manifest' || arg.startsWith('--manifest=')) args.manifest = readValue();
    else if (arg === '--log' || arg.startsWith('--log=')) args.log = readValue();
    else if (arg === '--out-dir' || arg.startsWith('--out-dir=')) args.outDir = readValue();
    else if (arg === '--html-only') args.htmlOnly = true;
    else if (arg === '--with-markdown' || arg === '--markdown') args.htmlOnly = false;
    else if (arg === '--style-source-html' || arg.startsWith('--style-source-html=')) args.styleSourceHtml = readValue();
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}
function usage() {
  return `Usage:
  node generate_test_report.js --description "<case>" --script <script.js> \\
    --command "<redacted command>" --result-json <result.json> [--result-json <prior.json>] \\
    [--case-ids F0-07,F0-12] \\
    [--failure-analysis <failure-analysis.json>] \\
    [--out-dir <canonical-case-dir>] [--title <title>] [--style-source-html <report.html>]

  node generate_test_report.js --manifest <run-manifest.json> \\
    [--out-dir <canonical-case-dir>] [--title <title>] [--style-source-html <report.html>]

Default output:
  HTML only at <pwd>/worktree/<case-id>/report.html.
  Aggregate HTML uses the same stable path and requires every manifest result to belong to one Case.
`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeCanonicalReport(file, content) {
  const reportFile = path.resolve(file);
  let existingStat = null;
  try {
    existingStat = fs.lstatSync(reportFile);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (existingStat?.isSymbolicLink()) {
    throw new Error(`Canonical report.html must not be a symbolic link: ${reportFile}`);
  }
  if (existingStat && !existingStat.isFile()) {
    throw new Error(`Canonical report.html must be a regular file: ${reportFile}`);
  }
  if (existingStat && fs.realpathSync(reportFile) !== reportFile) {
    throw new Error(`Canonical report.html realpath differs from its lexical path: ${reportFile}`);
  }

  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let descriptor;
  try {
    descriptor = fs.openSync(
      reportFile,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | noFollow,
      0o666,
    );
    if (!fs.fstatSync(descriptor).isFile()) {
      throw new Error(`Canonical report.html must be a regular file: ${reportFile}`);
    }
    fs.writeFileSync(descriptor, content);
  } catch (error) {
    if (error.code === 'ELOOP') {
      throw new Error(`Canonical report.html must not be a symbolic link: ${reportFile}`);
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readTextIfExists(file) {
  if (!file || !fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8');
}

const SENSITIVE_KEY_SOURCE = '(?:(?:[a-z0-9]+[_-])*(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|password|passwd|pwd|verify[_-]?code|verification[_-]?code|otp|session(?:[_-]?(?:id|key))?|set[_-]?cookie|proxy[_-]?authorization|authorization|cookie|api[_-]?key|client[_-]?secret|secret))';
const SENSITIVE_KEY_RE = new RegExp(`^${SENSITIVE_KEY_SOURCE}$`, 'i');
function redactFreeText(value) {
  const text = String(value || '')
    .replace(/((?:SESSION_ID|SESSION)=)[^'"\s;]+/gi, '$1***')
    .replace(/((?:Authorization|Set-Cookie|Cookie):\s*)[^\r\n；。]*/gi, '$1***')
    .replace(/(Bearer\s+)[a-zA-Z0-9._~+/=-]+/gi, '$1***')
    .replace(/(--cookie(?:=|\s+))[^'"\s]+/gi, '$1***')
    .replace(/(--token(?:=|\s+))[^'"\s]+/gi, '$1***')
    .replace(/(--password(?:=|\s+))[^'"\s]+/gi, '$1***')
    .replace(/\b(1(?:16|[3-9]\d))\d{4}(\d{4})\b/g, '$1****$2')
    .replace(/\b(\d{6})\d{8}(\d{3}[0-9X])\b/gi, '$1********$2');
  return redactAssignments(text);
}

function quotedValueEnd(text, start, quote) {
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === '\r' || char === '\n' || char === '；' || char === '。') {
      return -1;
    } else if (char === quote) {
      return index;
    }
  }
  return -1;
}

function redactAssignments(text) {
  const assignmentRe = new RegExp(`(?<![\\w-])(["']?)(${SENSITIVE_KEY_SOURCE})\\1\\s*[:=]\\s*`, 'gi');
  let output = '';
  let cursor = 0;
  let match;
  while ((match = assignmentRe.exec(text)) !== null) {
    const valueStart = assignmentRe.lastIndex;
    const quote = text[valueStart] === '"' || text[valueStart] === "'" ? text[valueStart] : '';
    let valueEnd;
    if (quote) {
      const closingQuote = quotedValueEnd(text, valueStart, quote);
      valueEnd = closingQuote >= 0
        ? closingQuote + 1
        : valueStart + text.slice(valueStart).search(/[\r\n；。]/);
    } else {
      const boundary = text.slice(valueStart).search(/[\s&#,;；，。}\]]/);
      valueEnd = boundary >= 0 ? valueStart + boundary : text.length;
    }
    if (valueEnd < valueStart) valueEnd = text.length;
    output += text.slice(cursor, match.index) + match[0] + (quote ? `${quote}***${quote}` : '***');
    cursor = valueEnd;
    assignmentRe.lastIndex = valueEnd;
  }
  return output + text.slice(cursor);
}

function jsonFragmentEnd(text, start) {
  const stack = [text[start] === '{' ? '}' : ']'];
  let inString = false;
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      stack.push('}');
    } else if (char === '[') {
      stack.push(']');
    } else if (char === '}' || char === ']') {
      if (stack.pop() !== char) return -1;
      if (!stack.length) return index + 1;
    }
  }
  return -1;
}

function redactJsonValue(value) {
  if (Array.isArray(value)) return value.map(redactJsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEY_RE.test(key) ? '***' : redactJsonValue(item),
    ]));
  }
  return typeof value === 'string' ? redactFreeText(value) : value;
}

function redactJsonFragments(text) {
  let output = '';
  let cursor = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '{' && text[index] !== '[') continue;
    const end = jsonFragmentEnd(text, index);
    if (end < 0) continue;
    try {
      const parsed = JSON.parse(text.slice(index, end));
      output += text.slice(cursor, index) + JSON.stringify(redactJsonValue(parsed));
      cursor = end;
      index = end - 1;
    } catch (_) {
      // Continue scanning so nested valid JSON can still be sanitized.
    }
  }
  return output + text.slice(cursor);
}

function redact(value) {
  return redactFreeText(redactJsonFragments(String(value || '')));
}

function decodeUrlComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch (_error) {
    return value;
  }
}

function encodeUrlPathSegment(value) {
  const pathCharacters = {
    '%24': '$', '%26': '&', '%2B': '+', '%2C': ',', '%3A': ':', '%3B': ';',
    '%3D': '=', '%40': '@', '%5B': '[', '%5D': ']',
  };
  return encodeURIComponent(value).replace(
    /%(?:24|26|2B|2C|3A|3B|3D|40|5B|5D)/gi,
    (encoded) => pathCharacters[encoded.toUpperCase()],
  );
}

function redactUrl(value) {
  const raw = String(value || '');
  try {
    const parsed = new URL(raw);
    if (parsed.username) parsed.username = redact(decodeUrlComponent(parsed.username));
    if (parsed.password) parsed.password = '***';
    parsed.pathname = parsed.pathname
      .split('/')
      .map((segment) => encodeUrlPathSegment(redact(decodeUrlComponent(segment))))
      .join('/');
    const parameters = [...parsed.searchParams.entries()];
    parsed.search = '';
    for (const [key, parameterValue] of parameters) {
      parsed.searchParams.append(
        key,
        SENSITIVE_KEY_RE.test(key) ? '***' : redact(parameterValue),
      );
    }
    if (parsed.hash) {
      const hashText = parsed.hash.slice(1);
      if (hashText.includes('=')) {
        const hashParameters = new URLSearchParams(hashText);
        const redactedHash = new URLSearchParams();
        for (const [key, parameterValue] of hashParameters) {
          redactedHash.append(
            key,
            SENSITIVE_KEY_RE.test(key) ? '***' : redact(parameterValue),
          );
        }
        parsed.hash = redactedHash.toString();
      } else {
        parsed.hash = encodeURIComponent(redact(decodeUrlComponent(hashText)));
      }
    }
    return parsed.toString();
  } catch (_error) {
    return redact(raw);
  }
}

function safeFilePart(value) {
  return String(value || 'test-report')
    .replace(/[^\p{Letter}\p{Number}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'test-report';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fileHref(file) {
  return pathToFileURL(path.resolve(file)).href;
}

function fileLabel(file) {
  return path.basename(String(file || '')) || String(file || '-');
}

function linkedPathHtml(file, label = fileLabel(file)) {
  const resolved = path.resolve(file);
  return `<a class="path-link" href="${escapeHtml(fileHref(resolved))}" target="_blank" rel="noreferrer" title="${escapeHtml(resolved)}">${codeHtml(label)}</a>`;
}

function markdownTitle(file) {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return '';
  const heading = fs.readFileSync(file, 'utf8').match(/^#\s+(.+?)\s*$/m);
  return heading
    ? heading[1]
      .trim()
      .replace(/\s+Detail\s*-\s*最终执行版\s*[：:]\s*/i, '：')
      .replace(/\s*-\s*最终执行版\s*[：:]\s*/, '：')
    : '';
}

function resolveCasePresentation(args, finalResult, resultFiles, outDir) {
  const candidates = [
    finalResult.casePath,
    finalResult.case,
    path.join(outDir, 'case.md'),
    args.script ? path.join(path.dirname(path.resolve(args.script)), 'case.md') : '',
    resultFiles.length ? path.join(path.dirname(path.resolve(resultFiles[resultFiles.length - 1])), 'case.md') : '',
  ];
  const casePath = candidates.find((candidate) => {
    if (!candidate || typeof candidate !== 'string') return false;
    try {
      return fs.statSync(path.resolve(candidate)).isFile();
    } catch {
      return false;
    }
  });
  const resolvedCasePath = casePath ? path.resolve(casePath) : '';
  const fallbackCase = typeof finalResult.case === 'string' && !path.isAbsolute(finalResult.case)
    ? finalResult.case
    : path.basename(outDir);
  return {
    casePath: resolvedCasePath,
    title: args.title || markdownTitle(resolvedCasePath) || fallbackCase || 'Webapp E2E Case',
  };
}

function casePathHtml(casePath) {
  if (!casePath) return '';
  return `<div class="case-path">Case 路径：${linkedPathHtml(casePath, casePath)}</div>`;
}

function fileLinkListHtml(files) {
  const links = files.filter(Boolean).map((file) => linkedPathHtml(path.resolve(file)));
  return links.length ? `<div class="file-list">${links.join('')}</div>` : '-';
}

function inlineHtml(value) {
  const text = String(value ?? '');
  const localPath = /(^|[\s：:；;（(])\/(?!\/)[^\s`<>"'，；。！？、]+/g;
  let html = '';
  let lastIndex = 0;

  for (const match of text.matchAll(localPath)) {
    const raw = match[0].slice(match[1].length);
    const start = match.index + match[1].length;
    let file = raw;
    let suffix = '';
    while (/[)\],.;:]$/.test(file)) {
      suffix = file.slice(-1) + suffix;
      file = file.slice(0, -1);
    }

    html += escapeHtml(text.slice(lastIndex, start));
    if (file && path.isAbsolute(file) && fs.existsSync(file)) {
      html += linkedPathHtml(file);
    } else {
      html += escapeHtml(file);
    }
    html += escapeHtml(suffix);
    lastIndex = start + raw.length;
  }

  html += escapeHtml(text.slice(lastIndex));
  return html;
}

function mdCell(value) {
  return String(value ?? '-').replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

function markdownSafeCell(value) {
  return mdCell(escapeHtml(value ?? '-').replace(/([\\`*_\[\]])/g, '\\$1'));
}

function normalizeLabelMap(value) {
  if (!value) return {};
  if (Array.isArray(value)) {
    const entries = value
      .map((item) => {
        if (Array.isArray(item)) return item;
        if (item && typeof item === 'object') {
          return [item.key || item.name, item.zhName || item.zh || item.cn || item.label || item.title || item.enName || item.en];
        }
        return null;
      })
      .filter((item) => item && item[0] && item[1]);
    return Object.fromEntries(entries);
  }
  if (typeof value === 'object') return { ...value };
  return {};
}

function fieldKeyForEntry(entry, fallbackKey) {
  if (!entry || typeof entry !== 'object') return fallbackKey;
  return entry.key || entry.name || entry.id || entry.resultKey || entry.enName || entry.en || fallbackKey;
}

function fieldLabelForEntry(entry, fallbackLabel) {
  if (!entry || typeof entry !== 'object') return fallbackLabel;
  return entry.zhName || entry.zh || entry.cn || entry.label || entry.title || fallbackLabel;
}

function addFieldMeta(meta, key, label) {
  if (!key) return;
  const normalizedKey = String(key);
  if (!meta.fieldOrder.includes(normalizedKey)) meta.fieldOrder.push(normalizedKey);
  if (label) meta.fieldLabels[normalizedKey] = String(label);
}

function normalizeReportFields(value) {
  const meta = {
    fieldLabels: {},
    fieldOrder: [],
  };
  if (!value) return meta;

  if (Array.isArray(value)) {
    for (const item of value) {
      if (Array.isArray(item)) {
        addFieldMeta(meta, item[0], item[1]);
      } else if (typeof item === 'string') {
        addFieldMeta(meta, item, '');
      } else if (item && typeof item === 'object') {
        const key = fieldKeyForEntry(item);
        addFieldMeta(meta, key, fieldLabelForEntry(item, item.label || item.title || item.enName || item.en));
      }
    }
    return meta;
  }

  if (typeof value === 'object') {
    for (const [key, label] of Object.entries(value)) {
      if (label && typeof label === 'object') {
        addFieldMeta(meta, fieldKeyForEntry(label, key), fieldLabelForEntry(label, label.label || label.title || key));
      } else {
        addFieldMeta(meta, key, label);
      }
    }
  }

  return meta;
}

function addInputMappedFields(meta, inputs) {
  if (!Array.isArray(inputs)) return;
  for (const input of inputs) {
    if (!input || typeof input !== 'object') continue;
    const resultKeys = Array.isArray(input.resultKeys)
      ? input.resultKeys
      : input.resultKey
        ? [input.resultKey]
        : [];
    for (const key of resultKeys) {
      addFieldMeta(meta, key, fieldLabelForEntry(input, input.label || input.title || key));
    }
  }
}

function reportMetaFromCaseContextMapping(mapping) {
  const meta = {
    stepTitles: {},
    fieldLabels: {},
    fieldOrder: [],
  };
  if (!mapping || typeof mapping !== 'object') return meta;

  if (Array.isArray(mapping.stepReports)) {
    meta.stepTitles = Object.fromEntries(mapping.stepReports.map(([name, title]) => [name, title]));
  }

  const reportFields = normalizeReportFields(mapping.reportFields || mapping.reportMeta?.fields || mapping.fields);
  Object.assign(meta.fieldLabels, reportFields.fieldLabels);
  meta.fieldOrder.push(...reportFields.fieldOrder);
  if (!meta.fieldOrder.length) addInputMappedFields(meta, mapping.inputs);

  return meta;
}

function mergeFieldOrder(...orders) {
  const seen = new Set();
  return orders
    .flat()
    .filter((key) => {
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function loadResultReportMeta(results) {
  const meta = {
    stepTitles: {},
    fieldLabels: {},
    fieldOrder: [],
  };
  for (const result of results) {
    if (Array.isArray(result.stepReports)) {
      Object.assign(meta.stepTitles, Object.fromEntries(result.stepReports.map(([name, title]) => [name, title])));
    }
    const mappingMeta = reportMetaFromCaseContextMapping(result.caseContextMapping);
    Object.assign(meta.stepTitles, mappingMeta.stepTitles);
    Object.assign(meta.fieldLabels, mappingMeta.fieldLabels);
    meta.fieldOrder = mergeFieldOrder(meta.fieldOrder, mappingMeta.fieldOrder);
  }
  return meta;
}

function extractLiteralAfterPattern(source, pattern) {
  const match = source.match(pattern);
  if (!match) return null;

  const start = match.index + match[0].length;
  const opener = source[start];
  const closerByOpener = { '[': ']', '{': '}', '(': ')' };
  if (!closerByOpener[opener]) return null;

  const stack = [];
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = '';
      }
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      i += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (closerByOpener[char]) {
      stack.push(closerByOpener[char]);
      continue;
    }
    if (stack.length && char === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) return source.slice(start, i + 1);
    }
  }

  return null;
}

function extractAssignedLiteral(source, name) {
  return extractLiteralAfterPattern(source, new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*`))
    || extractLiteralAfterPattern(source, new RegExp(`(?:module\\.exports|exports)\\.${name}\\s*=\\s*`));
}

class StaticLiteralParser {
  constructor(source, bindings = {}) {
    this.source = source;
    this.bindings = bindings;
    this.index = 0;
  }

  fail(message) {
    throw new Error(`${message} at offset ${this.index}`);
  }

  skipIgnored() {
    while (this.index < this.source.length) {
      if (/\s/u.test(this.source[this.index])) {
        this.index += 1;
        continue;
      }
      if (this.source.startsWith('//', this.index)) {
        const newline = this.source.indexOf('\n', this.index + 2);
        this.index = newline === -1 ? this.source.length : newline + 1;
        continue;
      }
      if (this.source.startsWith('/*', this.index)) {
        const end = this.source.indexOf('*/', this.index + 2);
        if (end === -1) this.fail('Unterminated block comment');
        this.index = end + 2;
        continue;
      }
      break;
    }
  }

  parse() {
    this.skipIgnored();
    const value = this.parseValue();
    this.skipIgnored();
    if (this.index !== this.source.length) this.fail('Unexpected expression syntax');
    return value;
  }

  parseValue() {
    this.skipIgnored();
    const char = this.source[this.index];
    if (char === '[') return this.parseArray();
    if (char === '{') return this.parseObject();
    if (char === '"' || char === "'" || char === '`') return this.parseString();
    if (char === '-' || /\d/u.test(char || '')) return this.parseNumber();
    const identifier = this.parseIdentifier();
    if (identifier === 'true') return true;
    if (identifier === 'false') return false;
    if (identifier === 'null') return null;
    if (identifier && Object.prototype.hasOwnProperty.call(this.bindings, identifier)) {
      return this.bindings[identifier];
    }
    this.fail('Only static data literals are supported');
  }

  parseIdentifier() {
    const match = this.source.slice(this.index).match(/^[$A-Z_a-z][$\w]*/u);
    if (!match) return '';
    this.index += match[0].length;
    return match[0];
  }

  parseNumber() {
    const match = this.source.slice(this.index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u);
    if (!match) this.fail('Invalid numeric literal');
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.fail('Numeric literal must be finite');
    return value;
  }

  parseString() {
    const quote = this.source[this.index++];
    let value = '';
    while (this.index < this.source.length) {
      const char = this.source[this.index++];
      if (char === quote) return value;
      if (quote === '`' && char === '$' && this.source[this.index] === '{') {
        this.fail('Template interpolation is not a static literal');
      }
      if (char !== '\\') {
        if (quote !== '`' && (char === '\n' || char === '\r')) this.fail('Unterminated string literal');
        value += char;
        continue;
      }
      if (this.index >= this.source.length) this.fail('Unterminated string escape');
      const escaped = this.source[this.index++];
      const simpleEscapes = {
        b: '\b',
        f: '\f',
        n: '\n',
        r: '\r',
        t: '\t',
        v: '\v',
        0: '\0',
      };
      if (Object.prototype.hasOwnProperty.call(simpleEscapes, escaped)) {
        value += simpleEscapes[escaped];
      } else if (escaped === 'x') {
        const hex = this.source.slice(this.index, this.index + 2);
        if (!/^[0-9a-f]{2}$/iu.test(hex)) this.fail('Invalid hexadecimal escape');
        value += String.fromCharCode(Number.parseInt(hex, 16));
        this.index += 2;
      } else if (escaped === 'u') {
        if (this.source[this.index] === '{') {
          const end = this.source.indexOf('}', this.index + 1);
          if (end === -1) this.fail('Invalid Unicode escape');
          const hex = this.source.slice(this.index + 1, end);
          if (!/^[0-9a-f]{1,6}$/iu.test(hex)) this.fail('Invalid Unicode escape');
          value += String.fromCodePoint(Number.parseInt(hex, 16));
          this.index = end + 1;
        } else {
          const hex = this.source.slice(this.index, this.index + 4);
          if (!/^[0-9a-f]{4}$/iu.test(hex)) this.fail('Invalid Unicode escape');
          value += String.fromCharCode(Number.parseInt(hex, 16));
          this.index += 4;
        }
      } else if (escaped === '\n') {
      } else if (escaped === '\r') {
        if (this.source[this.index] === '\n') this.index += 1;
      } else {
        value += escaped;
      }
    }
    this.fail('Unterminated string literal');
  }

  parseArray() {
    const value = [];
    this.index += 1;
    this.skipIgnored();
    if (this.source[this.index] === ']') {
      this.index += 1;
      return value;
    }
    while (this.index < this.source.length) {
      value.push(this.parseValue());
      this.skipIgnored();
      if (this.source[this.index] === ']') {
        this.index += 1;
        return value;
      }
      if (this.source[this.index] !== ',') this.fail('Expected comma in array literal');
      this.index += 1;
      this.skipIgnored();
      if (this.source[this.index] === ']') {
        this.index += 1;
        return value;
      }
    }
    this.fail('Unterminated array literal');
  }

  parseObject() {
    const value = Object.create(null);
    this.index += 1;
    this.skipIgnored();
    if (this.source[this.index] === '}') {
      this.index += 1;
      return value;
    }
    while (this.index < this.source.length) {
      this.skipIgnored();
      const char = this.source[this.index];
      const key = char === '"' || char === "'" || char === '`'
        ? this.parseString()
        : this.parseIdentifier();
      if (!key) this.fail('Object keys must be identifiers or string literals');
      this.skipIgnored();
      if (this.source[this.index] === ':') {
        this.index += 1;
        value[key] = this.parseValue();
      } else if (Object.prototype.hasOwnProperty.call(this.bindings, key)) {
        value[key] = this.bindings[key];
      } else {
        this.fail('Object shorthand requires a previously parsed static literal');
      }
      this.skipIgnored();
      if (this.source[this.index] === '}') {
        this.index += 1;
        return value;
      }
      if (this.source[this.index] !== ',') this.fail('Expected comma in object literal');
      this.index += 1;
      this.skipIgnored();
      if (this.source[this.index] === '}') {
        this.index += 1;
        return value;
      }
    }
    this.fail('Unterminated object literal');
  }
}

function parseStaticLiteral(snippet, bindings = {}) {
  if (!snippet) return undefined;
  return new StaticLiteralParser(snippet, bindings).parse();
}

function readScriptLiterals(source) {
  const names = [
    'F0_CASE_CATALOG',
    'CASE_CATALOG',
    'F0_PRD_CASE_DETAILS',
    'CASE_DETAILS',
    'STEP_REPORTS',
    'CASE_CONTEXT_MAPPING',
    'REPORT_META',
    'REPORT_METADATA',
    'REPORT_FIELD_LABELS',
    'FIELD_LABELS',
    'REPORT_FIELDS',
    'REPORT_FIELD_ORDER',
  ];
  const literals = Object.create(null);
  for (const name of names) {
    try {
      const direct = parseStaticLiteral(extractAssignedLiteral(source, name), literals);
      if (direct !== undefined) literals[name] = direct;
    } catch {}
  }
  try {
    const moduleExports = parseStaticLiteral(
      extractLiteralAfterPattern(source, /module\.exports\s*=\s*/),
      literals,
    );
    if (moduleExports && typeof moduleExports === 'object') {
      for (const name of names) {
        if (!Object.prototype.hasOwnProperty.call(literals, name)
            && Object.prototype.hasOwnProperty.call(moduleExports, name)) {
          literals[name] = moduleExports[name];
        }
      }
    }
  } catch {}
  return literals;
}

function loadScriptReportMeta(script) {
  const meta = {
    stepTitles: {},
    fieldLabels: {},
    fieldOrder: [],
    caseDefinitions: {},
  };
  if (!script) return meta;
  try {
    const source = fs.readFileSync(path.resolve(script), 'utf8');
    const literals = readScriptLiterals(source);
    const stepReports = literals.STEP_REPORTS;
    const caseContextMapping = literals.CASE_CONTEXT_MAPPING;
    const caseCatalog = literals.F0_CASE_CATALOG
      || literals.CASE_CATALOG
      || [];
    const caseDetails = literals.F0_PRD_CASE_DETAILS
      || literals.CASE_DETAILS
      || {};
    const reportMeta = literals.REPORT_META
      || literals.REPORT_METADATA
      || {};
    if (Array.isArray(stepReports)) {
      meta.stepTitles = Object.fromEntries(stepReports.map(([name, title]) => [name, title]));
    }
    const mappingMeta = reportMetaFromCaseContextMapping(caseContextMapping);
    const legacyFieldLabels = normalizeLabelMap(
      reportMeta.fieldLabels
        || reportMeta.fields
        || literals.REPORT_FIELD_LABELS
        || literals.FIELD_LABELS
        || literals.REPORT_FIELDS,
    );
    const legacyFieldOrder = Array.isArray(reportMeta.fieldOrder)
      ? reportMeta.fieldOrder
      : Array.isArray(literals.REPORT_FIELD_ORDER)
        ? literals.REPORT_FIELD_ORDER
        : Object.keys(legacyFieldLabels);
    meta.stepTitles = { ...meta.stepTitles, ...mappingMeta.stepTitles };
    meta.fieldLabels = { ...legacyFieldLabels, ...mappingMeta.fieldLabels };
    meta.fieldOrder = mergeFieldOrder(mappingMeta.fieldOrder, legacyFieldOrder, Object.keys(meta.fieldLabels));
    if (Array.isArray(caseCatalog)) {
      for (const item of caseCatalog) {
        const caseId = String(item?.caseId || '');
        if (!caseId) continue;
        meta.caseDefinitions[caseId] = { ...item, ...(caseDetails[caseId] || {}) };
      }
    }
    return meta;
  } catch {
    return meta;
  }
}

function resultStepStatus(result, name) {
  if (result.steps && result.steps[name]) return result.steps[name];
  if ((result.completedSteps || []).includes(name)) return '成功';
  if ((result.skippedSteps || []).includes(name)) return '跳过';
  if (result.failedStep === name) return '失败';
  return '';
}

function priorSuccessForStep(name, finalResult, allResults, resultFiles) {
  for (let i = allResults.length - 1; i >= 0; i -= 1) {
    const result = allResults[i];
    if (result === finalResult) continue;
    if (resultStepStatus(result, name) !== '成功') continue;
    return {
      result,
      file: resultFiles[i],
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
    };
  }
  return null;
}

function formatResultTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return formatLocalDateTime(date);
}

function formatDurationMs(value) {
  const durationMs = Number(value);
  if (!Number.isFinite(durationMs) || durationMs < 0) return '-';
  if (durationMs < 1_000) return `${Math.round(durationMs)} 毫秒`;
  if (durationMs < 60_000) {
    const seconds = Math.round(durationMs / 10) / 100;
    return `${seconds} 秒`;
  }
  const totalSeconds = Math.round(durationMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
}

function timingForStep(result, name) {
  return result.stepTimings?.[name] || result.stageTimings?.[name] || null;
}

function stringList(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (value === undefined || value === null || value === '') return [];
  return [String(value)];
}

function missingFailureEvidence(result) {
  const missing = [];
  const candidates = result.networkEvidence?.failureCandidates
    || result.network_evidence?.failure_candidates;
  if (!result.screenshot) missing.push('失败截图或可见页面状态');
  if (!result.url) missing.push('失败时页面 URL');
  if ((!Array.isArray(candidates) || !candidates.length)
    && (!result.observedResponses || !Object.keys(result.observedResponses).length)) {
    missing.push('相关 UI 网络响应或业务错误响应');
  }
  if (!result.stepTimings && !result.stageTimings) missing.push('失败阶段耗时与时序信息');
  return missing;
}

function normalizeNetworkEvidence(result, source) {
  const ownsCamelCase = source && Object.prototype.hasOwnProperty.call(source, 'networkEvidence');
  const ownsSnakeCase = source && Object.prototype.hasOwnProperty.call(source, 'network_evidence');
  const ownsExplicit = ownsCamelCase || ownsSnakeCase;
  const explicit = ownsCamelCase ? source.networkEvidence : source?.network_evidence;
  const fallback = result?.networkEvidence?.failureCandidates
    || result?.network_evidence?.failure_candidates;
  const items = ownsExplicit
    ? Array.isArray(explicit) ? explicit : []
    : Array.isArray(fallback) ? fallback : [];
  return items.slice(0, 3).map((candidate) => {
    const item = candidate && typeof candidate === 'object' ? candidate : {};
    return {
      method: String(item.method || 'UNKNOWN').toUpperCase(),
      url: redactUrl(item.url || '-'),
      traceId: String(item.traceId || item.trace_id || ''),
      summary: redact(item.summary || '已捕获关联接口，但未提供分析摘要。'),
    };
  });
}

const FAILURE_CATEGORIES = new Set([
  'automation-startup',
  'automation-assertion',
  'automation-technical',
  'environment-auth-input',
  'product-defect',
  'unknown',
]);

function normalizeFailureCategory(source) {
  return FAILURE_CATEGORIES.has(source?.category) ? source.category : 'unknown';
}

function normalizeRepairSummary(source) {
  const repair = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  const history = Array.isArray(repair.history) ? repair.history.slice(0, 2).map((entry, index) => {
    const item = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
    return {
      round: Number.isInteger(item.round) && item.round > 0 ? item.round : index + 1,
      summary: String(item.repairSummary || item.summary || item.diagnosis || '未提供修复摘要。'),
      verification: String(item.verification || item.status || '未提供验证结果。'),
    };
  }) : [];
  return {
    roundsUsed: Number.isInteger(repair.roundsUsed) && repair.roundsUsed >= 0 ? repair.roundsUsed : history.length,
    maxAutomaticRounds: 10,
    history,
    stopReason: String(repair.stopReason || repair.stop_reason || repair.status || '未提供最终停止原因。'),
  };
}

function normalizeFailureAnalysis(result, explicitAnalysis) {
  const source = explicitAnalysis || result.failureAnalysis || result.failure_analysis;
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    let status = ['confirmed', 'inferred', 'unconfirmed'].includes(source.status)
      ? source.status
      : source.rootCause || source.root_cause
        ? 'inferred'
        : 'unconfirmed';
    const evidence = stringList(source.evidence);
    const missingEvidence = stringList(source.missingEvidence || source.missing_evidence);
    if (status !== 'unconfirmed' && !evidence.length) {
      status = 'unconfirmed';
      missingEvidence.unshift('根因判断缺少可核验的支持证据');
    }
    return {
      status,
      category: normalizeFailureCategory(source),
      directCause: String(source.directCause || source.direct_cause || firstLine(result.error) || '执行结果标记失败，但未提供直接错误。'),
      rootCause: String(source.rootCause || source.root_cause || '尚无法确定根因。'),
      evidence,
      impact: String(source.impact || '失败步骤及后续步骤未完成；业务副作用范围需结合 checkpoint 和响应确认。'),
      recommendation: String(source.recommendation || source.nextAction || source.next_action || '补充缺失证据后重新诊断，根因确认前不要原样重跑不可逆步骤。'),
      missingEvidence,
      networkEvidence: normalizeNetworkEvidence(result, source),
      repair: normalizeRepairSummary(source.repair || result.repair),
    };
  }

  const evidence = [];
  if (result.failedStep) evidence.push(`失败步骤：${result.failedStep}`);
  if (firstLine(result.error)) evidence.push(`错误摘要：${firstLine(result.error)}`);
  if (result.url) evidence.push(`失败 URL：${result.url}`);
  if (result.screenshot) evidence.push(`失败截图：${result.screenshot}`);
  return {
    status: 'unconfirmed',
    category: 'unknown',
    directCause: firstLine(result.error) || '执行结果标记失败，但未提供直接错误。',
    rootCause: '尚无法确定根因。当前证据只证明失败现象，不能区分脚本缺陷、页面时序、登录或权限、环境异常与业务拒绝。',
    evidence,
    impact: '失败步骤及后续步骤未完成；是否已产生业务副作用需结合 checkpoint 和接口响应确认。',
    recommendation: '补充失败页面、URL、相关网络响应、日志和副作用 checkpoint 后重新诊断；根因确认前不要原样重跑不可逆步骤。',
    missingEvidence: missingFailureEvidence(result),
    networkEvidence: normalizeNetworkEvidence(result, {}),
    repair: normalizeRepairSummary(result.repair),
  };
}

function isConfirmedProductDefect(analysis) {
  return analysis?.category === 'product-defect' && analysis?.status === 'confirmed';
}

function failureAnalysisStatusLabel(status) {
  if (status === 'confirmed') return '根因已确认';
  if (status === 'inferred') return '根因推断';
  return '根因未确认';
}

function failureCategoryLabel(category) {
  const labels = {
    'automation-startup': '自动化启动问题',
    'automation-assertion': '自动化断言问题',
    'automation-technical': '自动化技术问题',
    'environment-auth-input': '环境、认证或输入问题',
    'product-defect': '产品缺陷',
    unknown: '未知分类',
  };
  return labels[category] || labels.unknown;
}

function stepDetail(row, finalResult) {
  if (row.caseProvenance?.length) return caseProvenanceDetail(row.caseProvenance);
  if (row.proof) {
    const time = formatResultTime(row.proof.finishedAt || row.proof.startedAt);
    return `本轮 resume 跳过；前序运行已执行成功${time ? `（${time}）` : ''}：${path.resolve(row.proof.file)}`;
  }
  if (row.status === '跳过') return '本轮 resume 跳过；未在已传入的前序 JSON 中找到成功证据。';
  if (isFailureStatus(row.status) || row.status === '阻塞') {
    return `${row.status === '阻塞' ? '阻塞' : '失败'}摘要：${row.timing?.evidence?.reason || firstLine((row.sourceResult || finalResult).error) || '-'}`;
  }
  if (row.status === '未开始') return '因前置步骤失败，本步骤未执行。';
  if (row.status === '成功') {
    if (row.sourceResult && row.sourceResult !== finalResult && row.sourceFile) {
      const time = formatResultTime(row.sourceResult.finishedAt || row.sourceResult.startedAt);
      return `前序运行成功${time ? `（${time}）` : ''}：${path.resolve(row.sourceFile)}`;
    }
    return '本轮执行成功。';
  }
  return '-';
}

function timingBelongsToResult(timing, result) {
  if (!timing?.startedAt || !result?.startedAt) return true;
  const timingStarted = Date.parse(timing.startedAt);
  const runStarted = Date.parse(result.startedAt);
  const runFinished = Date.parse(result.finishedAt || '');
  if (!Number.isFinite(timingStarted) || !Number.isFinite(runStarted)) return true;
  if (timingStarted < runStarted - 1_000) return false;
  return !Number.isFinite(runFinished) || timingStarted <= runFinished + 1_000;
}

function combinedStepRows(results, resultFiles, stepTitles, caseExecution, plannedStepKeys = []) {
  const desired = [...new Set([...plannedStepKeys, ...caseExecution.flatMap((item) => item.stepKeys)])];
  const statusPriority = { 失败: 5, 阻塞: 4, 成功: 3, 前序成功: 3, 跳过: 2, 未开始: 1 };
  return desired.map((name) => {
    const caseProvenance = caseExecution
      .filter((item) => item.stepKeys.includes(name))
      .map((item) => {
        const index = Number.isInteger(item._sourceIndex) ? item._sourceIndex : results.length - 1;
        const result = results[index] || {};
        const status = result.steps?.[name]
          || ((result.completedSteps || []).includes(name) ? '成功' : (result.skippedSteps || []).includes(name) ? '跳过' : result.failedStep === name ? '失败' : '未开始');
        const timing = timingForStep(result, name);
        const inherited = result.mode === 'continuation'
          && result.continuation?.sourceResult
          && !timingBelongsToResult(timing, result);
        return {
          caseId: item.caseId,
          status,
          timing,
          sourceResult: result,
          sourceFile: inherited ? result.continuation.sourceResult : resultFiles[index],
          current: !inherited && index === results.length - 1,
          reason: timing?.evidence?.reason || ((isFailureStatus(status) || status === '阻塞') ? firstLine(result.error) : ''),
        };
      });
    const primary = [...caseProvenance].sort((left, right) => (statusPriority[right.status] || 0) - (statusPriority[left.status] || 0))[0];
    return primary ? {
      name,
      status: primary.status,
      title: stepTitles[name] || '',
      timing: caseProvenance.every((item) => item.sourceFile === primary.sourceFile) ? primary.timing : null,
      proof: null,
      sourceResult: primary.sourceResult,
      sourceFile: primary.sourceFile,
      caseProvenance,
    } : {
      name,
      status: '未开始',
      title: stepTitles[name] || '',
      timing: null,
      proof: null,
      caseProvenance: [],
    };
  });
}

function stepRows(result, stepTitles = {}, allResults = [], resultFiles = []) {
  if (result.steps && typeof result.steps === 'object') {
    return Object.entries(result.steps).map(([name, status]) => ({
      name,
      status,
      title: stepTitles[name] || '',
      timing: timingForStep(result, name),
      proof: status === '跳过' ? priorSuccessForStep(name, result, allResults, resultFiles) : null,
    }));
  }
  const completed = new Set(result.completedSteps || []);
  const skipped = new Set(result.skippedSteps || []);
  const failed = result.failedStep;
  const names = [...new Set([...(result.completedSteps || []), ...(result.skippedSteps || []), failed].filter(Boolean))];
  return names.map((name) => ({
    name,
    status: completed.has(name) ? '成功' : skipped.has(name) ? '跳过' : failed === name ? '失败' : '未开始',
    title: stepTitles[name] || '',
    timing: timingForStep(result, name),
    proof: skipped.has(name) ? priorSuccessForStep(name, result, allResults, resultFiles) : null,
  }));
}

function countStatuses(rows) {
  const counts = { 成功: 0, 失败: 0, 跳过: 0, 未开始: 0 };
  for (const row of rows) {
    const status = row.displayStatus || row.status;
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

function enrichStepRows(rows, finalResult) {
  const strictTestFlowEvidence = Boolean(finalResult?.testFlow && typeof finalResult.testFlow === 'object');
  return rows.map((row) => {
    const displayStatus = isFailureStatus(row.status)
      ? '失败'
      : row.status === '跳过' && row.proof
        ? '前序成功'
        : row.status;
    const timing = row.timing || (row.proof ? timingForStep(row.proof.result, row.name) : null);
    const evidenceResult = row.sourceResult || row.proof?.result || finalResult;
    const stepArtifact = evidenceResult?.stepArtifacts?.[row.name] || null;
    const evidenceDefect = strictTestFlowEvidence && ['成功', '前序成功'].includes(displayStatus)
      && (!stepArtifact?.screenshot || !path.isAbsolute(stepArtifact.screenshot) || !fs.existsSync(stepArtifact.screenshot));
    return {
      ...row,
      displayStatus: evidenceDefect ? '失败' : displayStatus,
      evidenceDefect,
      timing,
      stepArtifact,
      durationText: formatDurationMs(timing?.durationMs),
      detail: evidenceDefect ? '证据失败：成功步骤缺少真实浏览器截图。' : stepDetail({ ...row, displayStatus }, finalResult),
    };
  });
}

function caseProvenanceDetail(items) {
  const groups = new Map();
  for (const item of items || []) {
    const source = item.sourceFile ? path.resolve(item.sourceFile) : '';
    const key = [item.status, source, item.reason || '', item.current ? 'current' : 'prior'].join('|');
    const group = groups.get(key) || { ...item, caseIds: [] };
    group.caseIds.push(item.caseId);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const prefix = `${group.caseIds.join('、')}：`;
    if (isFailureStatus(group.status) || group.status === '阻塞') return `${prefix}${group.status === '阻塞' ? '阻塞' : '失败'}摘要：${group.reason || '-'}`;
    if (group.status === '成功' && group.sourceFile) return `${prefix}${group.current ? '本轮执行成功' : '前序运行成功'}：${path.resolve(group.sourceFile)}`;
    if (group.status === '跳过') return `${prefix}本轮跳过，未找到同 lineage 的成功证据。`;
    return `${prefix}${group.status || '未开始'}。`;
  }).join('；');
}

function normalizeCaseStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (['passed', 'pass', 'success', 'succeeded', '成功', '通过'].includes(status)) return '通过';
  if (['failed', 'fail', 'failure', 'error', '失败'].includes(status)) return '失败';
  if (['blocked', 'blocking', '阻塞', '执行阻塞'].includes(status)) return '阻塞';
  if (['skipped', 'skip', 'not-run', 'not_started', '跳过', '未执行', '未开始'].includes(status)) return '未执行';
  return '';
}

function normalizeCaseExecution(results, requestedCaseIds = [], caseDefinitions = {}) {
  const finalResult = results[results.length - 1] || {};
  const testFlowCaseIds = Array.isArray(finalResult.testFlow?.caseIds)
    ? finalResult.testFlow.caseIds.map(String).filter(Boolean)
    : [];
  const selected = requestedCaseIds.length
    ? [...new Set(requestedCaseIds.map(String))]
    : testFlowCaseIds.length
      ? [...new Set(testFlowCaseIds)]
      : Array.isArray(finalResult.selectedCaseIds) && finalResult.selectedCaseIds.length
        ? [...new Set(finalResult.selectedCaseIds.map(String))]
        : (Array.isArray(finalResult.caseResults) ? finalResult.caseResults : []).map((item) => String(item.caseId || '')).filter(Boolean);
  const byId = new Map();
  results.forEach((result, sourceIndex) => {
    if (!Array.isArray(result.caseResults)) return;
    for (const item of result.caseResults) {
      const caseId = String(item.caseId || '');
      if (caseId) byId.set(caseId, { ...item, _sourceIndex: sourceIndex });
    }
  });
  return selected.map((caseId) => {
    const item = byId.get(caseId) || { caseId, status: '未执行' };
    const definition = caseDefinitions[caseId] || {};
    const normalizedStatus = normalizeCaseStatus(item.status);
    return {
      ...item,
      caseId,
      title: String(definition.title || item.title || item.name || caseId),
      status: normalizedStatus || '未执行',
      statusExplicit: Boolean(normalizedStatus),
      preconditions: stringList(definition.preconditions?.length ? definition.preconditions : item.preconditions),
      steps: stringList(definition.steps?.length ? definition.steps : item.steps),
      expectedResults: stringList(definition.expectedResults?.length ? definition.expectedResults : item.expectedResults),
      stepKeys: stringList(item.stepKeys?.length ? item.stepKeys : definition.stepKeys),
      expected: definition.expected || item.expected || item.expectedResult || item.expectation || '',
      actual: item.actual || item.actualResult || item.error || '',
    };
  });
}

function reconcileCaseStatuses(caseExecution, rows) {
  return caseExecution.map((item) => {
    const caseRows = rows.filter((row) => item.stepKeys.includes(row.name));
    if (item.statusExplicit && !(item.status === '通过' && caseRows.some((row) => row.evidenceDefect))) return item;
    let status = item.status;
    if (caseRows.some((row) => row.evidenceDefect)) status = '失败';
    else if (item.ok === true) status = '通过';
    else if (item.ok === false || normalizeCaseStatus(item.assertion?.status) === '失败') status = '失败';
    else if (caseRows.some((row) => isFailureStatus(row.status) || isFailureStatus(row.displayStatus))) status = '失败';
    else if (caseRows.some((row) => row.status === '阻塞')) status = '阻塞';
    else if (caseRows.some((row) => row.status === '未开始')) status = '阻塞';
    else if (caseRows.length && caseRows.every((row) => ['成功', '前序成功'].includes(row.displayStatus || row.status))) status = '通过';
    return { ...item, status };
  });
}

function caseStatusCounts(caseExecution) {
  const counts = { 通过: 0, 失败: 0, 阻塞: 0, 未执行: 0 };
  for (const item of caseExecution) counts[item.status] = (counts[item.status] || 0) + 1;
  return counts;
}

function normalizeTestFlow(finalResult, caseExecution, rows) {
  const source = finalResult?.testFlow && typeof finalResult.testFlow === 'object'
    ? finalResult.testFlow
    : {};
  return {
    flowId: String(source.flowId || finalResult?.case || 'default-test-flow'),
    title: String(source.title || finalResult?.case || '默认测试流'),
    definition: String(source.definition || 'Case 集合 + 有序步骤 + 数据依赖 + mutation checkpoint + 断点续跑 + 每步证据 + 最终断言'),
    caseIds: caseExecution.map((item) => item.caseId),
    stepKeys: Array.isArray(source.stepKeys) && source.stepKeys.length ? source.stepKeys.map(String) : rows.map((row) => row.name),
  };
}

function stepCaseMapForResults(results, caseExecution) {
  const selected = new Set(caseExecution.map((item) => item.caseId));
  const map = {};
  for (const result of results) {
    const explicit = result.stepCaseMap
      || result.caseContextMapping?.stepCaseMap
      || result.case_context_mapping?.step_case_map
      || {};
    for (const [step, caseIds] of Object.entries(explicit)) {
      map[step] ||= [];
      for (const caseId of stringList(caseIds).filter((value) => selected.has(value))) {
        if (!map[step].includes(caseId)) map[step].push(caseId);
      }
    }
  }
  for (const item of caseExecution) {
    for (const step of item.stepKeys) {
      map[step] ||= [];
      if (!map[step].includes(item.caseId)) map[step].push(item.caseId);
    }
  }
  return map;
}

function isSummaryStep(step) {
  return /(?:^|-)assert(?:-|$).*final|summary|汇总/i.test(String(step || ''));
}

function selectPrimaryFailureEvidence(finalResult, results, resultFiles, failedCaseIds, stepCaseMap, explicitAnalysis = null) {
  const explicitScreenshot = explicitAnalysis?.businessFailureScreenshot
    || explicitAnalysis?.business_failure_screenshot
    || finalResult.failureAnalysis?.businessFailureScreenshot
    || finalResult.failure_analysis?.business_failure_screenshot;
  if (explicitScreenshot) {
    return {
      result: {
        ...finalResult,
        failedStep: explicitAnalysis?.businessFailureStep || explicitAnalysis?.business_failure_step || finalResult.failedStep,
        error: explicitAnalysis?.directCause || explicitAnalysis?.direct_cause || finalResult.error,
        failureType: explicitAnalysis?.failureType || explicitAnalysis?.failure_type || finalResult.failureType,
      },
      file: resultFiles[resultFiles.length - 1],
      screenshot: explicitScreenshot,
    };
  }
  const candidates = [];
  for (const [index, result] of results.entries()) {
    if (result.failedStep || result.ok === false) {
      const mapped = stepCaseMap[result.failedStep] || [];
      const related = mapped.some((caseId) => failedCaseIds.has(caseId));
      const business = !isSummaryStep(result.failedStep);
      candidates.push({
        result,
        file: resultFiles[index],
        index,
        screenshot: result.screenshot || '',
        score: (related ? 100 : 0) + (business ? 20 : 0) + (result.screenshot ? 5 : 0) + index / 1000,
      });
    }

    for (const [step, rawArtifact] of Object.entries(result.stepArtifacts || {})) {
      const artifact = rawArtifact && typeof rawArtifact === 'object' ? rawArtifact : {};
      const status = result.steps?.[step] || artifact.status;
      if (!isFailureStatus(status) && status !== '阻塞') continue;
      const mapped = stepCaseMap[step] || [];
      const related = mapped.some((caseId) => failedCaseIds.has(caseId));
      const business = !isSummaryStep(step);
      const relatedCase = (result.caseResults || []).find((item) => mapped.includes(String(item.caseId)) && ['失败', '阻塞'].includes(normalizeCaseStatus(item.status)));
      const error = artifact.error || artifact.reason || relatedCase?.actual || result.error;
      candidates.push({
        result: { ...result, failedStep: step, error, screenshot: artifact.screenshot || result.screenshot || '' },
        file: resultFiles[index],
        index,
        screenshot: artifact.screenshot || '',
        score: (related ? 100 : 0) + (business ? 20 : 0) + (artifact.screenshot ? 5 : 0) + index / 1000,
      });
    }
  }
  candidates.sort((left, right) => right.score - left.score);
  return candidates[0] || {
    result: finalResult,
    file: resultFiles[resultFiles.length - 1],
    screenshot: finalResult.screenshot || '',
  };
}

function finalAssertion(finalResult) {
  return finalResult.stabilityGate?.finalAssertion
    || finalResult.stability_gate?.final_assertion
    || null;
}

function isNonEmptyPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Object.keys(value).length > 0;
}

function hasPassedFinalAssertion(finalResult) {
  const assertion = finalAssertion(finalResult);
  return assertion?.status === 'passed' && isNonEmptyPlainObject(assertion.evidence);
}

function isNonEmptyValue(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

const FAILURE_STATUSES = new Set(['失败', 'failed', 'fail', 'error', 'errored']);

function isFailureStatus(status) {
  return FAILURE_STATUSES.has(String(status === undefined || status === null ? '' : status).trim().toLowerCase());
}

function hasExecutionFailure(result, rows = []) {
  const rawStatuses = result.steps && typeof result.steps === 'object' && !Array.isArray(result.steps)
    ? Object.values(result.steps)
    : [];
  return result.ok === false
    || isNonEmptyValue(result.error)
    || isNonEmptyValue(result.failedStep)
    || rawStatuses.some(isFailureStatus)
    || rows.some((row) => isFailureStatus(row.displayStatus) || isFailureStatus(row.status));
}

function requiresFailureAnalysis(result, rows = []) {
  return hasExecutionFailure(result, rows)
    || !hasPassedFinalAssertion(result)
    || rows.some((row) => row.status === '跳过' && !row.proof);
}

function finalConclusion(finalResult, rows, allResults, failureAnalysis, caseCounts = null) {
  if (caseCounts && (caseCounts['失败'] > 0 || caseCounts['阻塞'] > 0 || caseCounts['未执行'] > 0)) {
    return caseCounts['失败'] > 0 && isConfirmedProductDefect(failureAnalysis) ? '不可提测' : '执行阻塞';
  }
  if (finalResult.ok === true && !hasExecutionFailure(finalResult, rows) && hasPassedFinalAssertion(finalResult)) {
    if (finalResult.testFlow && rows.some((row) => row.evidenceDefect || row.status === '未开始')) return '执行阻塞';
    const skipped = rows.some((row) => row.status === '跳过');
    if (!skipped) return '可提测';
    const proved = rows
      .filter((row) => row.status === '跳过')
      .every((row) => Boolean(row.proof));
    return proved ? '可提测' : '执行阻塞';
  }
  return isConfirmedProductDefect(failureAnalysis) ? '不可提测' : '执行阻塞';
}

function valueForReportField(result, key) {
  for (const source of [result.ids, result.input, result.output, result]) {
    if (source && source[key] !== undefined && source[key] !== null && source[key] !== '') return source[key];
  }
  return undefined;
}

function collectIds(results, fieldOrder = []) {
  const merged = {};
  for (const result of results) {
    Object.assign(merged, result.ids || {});
    for (const key of fieldOrder) {
      const value = valueForReportField(result, key);
      if (value !== undefined) merged[key] = value;
    }
  }
  return merged;
}

function finalAssertionSummary(finalResult) {
  const assertion = finalAssertion(finalResult);
  if (!assertion) {
    return '缺少通过的最终断言：需要 stabilityGate.finalAssertion.status="passed" 且 evidence 为非空对象。';
  }
  if (assertion.status !== 'passed') {
    return `最终断言未通过：status=${assertion.status || 'missing'}。`;
  }
  if (!isNonEmptyPlainObject(assertion.evidence)) {
    return '最终断言缺少非空对象 evidence，当前执行阻塞。';
  }
  return orderedEntries(assertion.evidence)
      .slice(0, 4)
      .map(([key, value]) => `${humanizeKey(key)}: ${typeof value === 'object' ? JSON.stringify(redactJsonValue(value)) : redact(value)}`)
      .join('；');
}

function summarizeArtifacts(args, resultFiles, results) {
  const files = [...resultFiles];
  const includeNetworkLogs = hasExecutionFailure(results[results.length - 1] || {});
  if (args.script) files.push(path.resolve(args.script));
  if (args.log) files.push(path.resolve(args.log));
  if (args.failureAnalysis) files.push(path.resolve(args.failureAnalysis));
  for (const result of results) {
    if (result.continuation?.sourceResult) files.push(path.resolve(result.continuation.sourceResult));
    if (result.continuation?.sourceCheckpoint) files.push(path.resolve(result.continuation.sourceCheckpoint));
    for (const key of ['screenshot', 'successScreenshot']) {
      if (result[key]) files.push(result[key]);
    }
    for (const artifact of Object.values(result.stepArtifacts || {})) {
      if (artifact?.screenshot) files.push(artifact.screenshot);
      for (const video of artifact?.videos || []) files.push(video);
    }
    for (const video of result.videoRecording?.artifacts || []) {
      if (video?.path) files.push(video.path);
    }
    const networkLog = result.networkEvidence?.logFile
      || result.network_evidence?.log_file;
    if (includeNetworkLogs && hasExecutionFailure(result) && networkLog && fs.existsSync(networkLog)) files.push(networkLog);
  }
  return [...new Set(files.filter(Boolean))];
}

function recordedVideoArtifacts(results) {
  const artifacts = [];
  const seen = new Set();
  for (const result of results || []) {
    for (const video of result.videoRecording?.artifacts || []) {
      if (!video?.path || seen.has(video.path)) continue;
      seen.add(video.path);
      artifacts.push({
        role: video.role || '页面录屏',
        step: video.step || '',
        context: video.context || '',
        path: video.path,
      });
    }
    for (const [step, artifact] of Object.entries(result.stepArtifacts || {})) {
      for (const videoPath of artifact?.videos || []) {
        if (!videoPath || seen.has(videoPath)) continue;
        seen.add(videoPath);
        artifacts.push({ role: '步骤录屏', step, context: '', path: videoPath });
      }
    }
  }
  return artifacts;
}

function continuationEvidenceHtml(results, provedSkipped = []) {
  const pairs = [];
  const seen = new Set();
  for (const result of results) {
    const sourceResult = result.continuation?.sourceResult;
    const sourceCheckpoint = result.continuation?.sourceCheckpoint;
    if (!sourceResult && !sourceCheckpoint) continue;
    const key = `${sourceResult || ''}|${sourceCheckpoint || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push([
      sourceResult ? `来源结果 ${linkedPathHtml(sourceResult)}` : '',
      sourceCheckpoint ? `来源 checkpoint ${linkedPathHtml(sourceCheckpoint)}` : '',
    ].filter(Boolean).join('；'));
  }
  if (pairs.length) {
    const backing = provedSkipped.length ? `；${provedSkipped.length} 个跳过步骤已有同 lineage 前序成功证据` : '';
    return `${pairs.join('<br/>')}${backing}。`;
  }
  return provedSkipped.length
    ? `${provedSkipped.length} 个步骤本轮跳过，但已由前序 JSON 证明执行成功。`
    : '本次结果未声明续跑来源。';
}

function formatJsonBlock(value) {
  return '```json\n' + JSON.stringify(value || {}, null, 2) + '\n```';
}

function codeHtml(value) {
  return `<code>${escapeHtml(value ?? '-')}</code>`;
}

function codeBlockHtml(value) {
  return `<pre class="cmd-block"><code>${escapeHtml(value ?? '-')}</code></pre>`;
}

function badgeKind(status) {
  const value = String(status || '');
  if (/不可|失败|脏数据|待确认/.test(value)) return 'red';
  if (/阻塞|有条件|跳过|未开始|未执行|参考|人工|风险/.test(value)) return 'amber';
  return 'green';
}

function badgeHtml(label, kind = badgeKind(label)) {
  return `<span class="badge b-${kind}">${escapeHtml(label)}</span>`;
}

function stepNameHtml(row) {
  const title = row.title || row.name;
  const code = row.title ? `<div class="step-code">${escapeHtml(row.name)}</div>` : '';
  return `<div class="step-name"><div class="step-title">${escapeHtml(title)}</div>${code}</div>`;
}

function stepStatusHtml(row) {
  const status = row.displayStatus || row.status;
  const note = status !== row.status
    ? `<div class="step-note">本轮状态：${escapeHtml(row.status)}</div>`
    : '';
  return `${badgeHtml(status)}${note}`;
}

function stepScreenshotHtml(row) {
  const screenshot = row.stepArtifact?.screenshot;
  if (!screenshot || !path.isAbsolute(screenshot) || !fs.existsSync(screenshot)) {
    return ['成功', '前序成功'].includes(row.displayStatus || row.status)
      ? '<span class="evidence-missing">成功步骤缺少截图证据</span>'
      : '<span class="note">未提供</span>';
  }
  const resolved = path.resolve(screenshot);
  const href = escapeHtml(fileHref(resolved));
  return `<a class="step-screenshot-link" href="${href}" target="_blank" rel="noreferrer" title="${escapeHtml(resolved)}"><img class="step-screenshot" src="${href}" alt="${escapeHtml(row.title || row.name)} 执行截图" loading="lazy"></a>`;
}

function stepEvidenceHtml(row) {
  const screenshot = stepScreenshotHtml(row);
  const videos = (row.stepArtifact?.videos || [])
    .filter((video) => path.isAbsolute(video) && fs.existsSync(video));
  if (!videos.length) return screenshot;
  const videoLinks = videos.map((video, index) => (
    `<a class="step-video-link" href="${escapeHtml(fileHref(path.resolve(video)))}" target="_blank" rel="noreferrer" title="${escapeHtml(path.resolve(video))}">录屏 ${index + 1}</a>`
  )).join('');
  return `${screenshot}<div class="step-video-list">${videoLinks}</div>`;
}

function videoRecordingHtml(results) {
  const videos = recordedVideoArtifacts(results);
  if (!videos.length) return '<p class="note">本次未启用录屏或未生成视频文件。</p>';
  return tableHtml(
    ['页面角色', '对应步骤', '上下文', '视频文件'],
    videos.map((video) => [
      escapeHtml(video.role),
      escapeHtml(video.step || '-'),
      escapeHtml(video.context || '-'),
      linkedPathHtml(video.path),
    ]),
    'summary-table',
  );
}

function stepLabelHtml(name, stepTitles = {}) {
  const title = stepTitles[name] || name || '-';
  const code = stepTitles[name] ? `<div class="step-code">${escapeHtml(name)}</div>` : '';
  return `<div class="step-name"><div class="step-title">${escapeHtml(title)}</div>${code}</div>`;
}

function stepLabelText(name, stepTitles = {}) {
  const title = stepTitles[name] || name || '-';
  return stepTitles[name] ? `${title}<br><small>${name}</small>` : title;
}

function stepLabelPlain(name, stepTitles = {}) {
  const title = stepTitles[name] || name || '-';
  return stepTitles[name] ? `${title}（${name}）` : title;
}

function detailListHtml(label, values, empty = '未提供') {
  const items = stringList(values);
  return `<div class="case-detail-row"><b>${escapeHtml(label)}：</b>${items.length
    ? `<ol>${items.map((item) => `<li>${inlineHtml(redact(item))}</li>`).join('')}</ol>`
    : `<span>${escapeHtml(empty)}</span>`}</div>`;
}

function caseDetailHtml(item) {
  const expected = item.expectedResults.length ? item.expectedResults : stringList(item.expected);
  return [
    `<div class="case-detail-title">${escapeHtml(item.caseId)} ${escapeHtml(item.title || '')}</div>`,
    detailListHtml('前置条件', item.preconditions),
    detailListHtml('业务步骤', item.steps),
    detailListHtml('预期结果', expected),
    item.actual ? `<div class="case-detail-row"><b>实际结果：</b>${inlineHtml(redact(item.actual))}</div>` : '',
  ].filter(Boolean).join('');
}

let caseTooltipSequence = 0;

function caseBadgeHtml(item) {
  caseTooltipSequence += 1;
  const tooltipId = `case-tooltip-${caseTooltipSequence}`;
  return `<div class="case-hover" tabindex="0" aria-describedby="${tooltipId}">${badgeHtml(item.caseId, badgeKind(item.status))}<div class="case-tooltip" id="${tooltipId}" role="tooltip">${caseDetailHtml(item)}</div></div>`;
}

function caseRefsHtml(caseIds, caseById) {
  if (!caseIds.length) return '<span class="note">无映射</span>';
  return `<div class="case-refs">${caseIds.map((caseId) => {
    const item = caseById.get(caseId) || {
      caseId,
      status: '未执行',
      preconditions: [],
      steps: [],
      expectedResults: [],
    };
    return caseBadgeHtml(item);
  }).join('')}</div>`;
}

function caseStepsHtml(item, stepTitles) {
  if (!item.stepKeys.length) return '<span class="note">未映射步骤</span>';
  return `<div class="case-step-list">${item.stepKeys.map((step) => stepLabelHtml(step, stepTitles)).join('')}</div>`;
}

function caseExecutionTableHtml(caseExecution, stepTitles) {
  if (!caseExecution.length) return '<p class="note">结果未提供 Case 执行数据。</p>';
  return tableHtml(
    ['Case', '结果', '对应步骤', '预期', '实际 / 失败原因'],
    caseExecution.map((item) => [
      `<div class="case-title-cell">${caseBadgeHtml(item)}<div><b>${escapeHtml(item.title || item.caseId)}</b><div class="step-code">悬浮或聚焦 Case ID 查看完整详情</div></div></div>`,
      badgeHtml(item.status),
      caseStepsHtml(item, stepTitles),
      analysisListHtml(item.expectedResults.length ? item.expectedResults : item.expected, '未提供'),
      inlineHtml(redact(item.actual || (item.status === '未执行' ? '未执行。' : '-'))),
    ]),
    'case-result-table',
  );
}

function humanizeKey(key) {
  const normalized = String(key || '-')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  return normalized
    .replace(/\buid\b/gi, 'UID')
    .replace(/\bid\b/gi, 'ID')
    .replace(/\burl\b/gi, 'URL')
    .replace(/\bjson\b/gi, 'JSON') || String(key || '-');
}

function dataKeyTitle(key, fieldLabels = {}) {
  return fieldLabels[key] || humanizeKey(key);
}

function dataKeyLabelHtml(key, fieldLabels = {}) {
  const title = dataKeyTitle(key, fieldLabels);
  const code = title !== key ? `<div class="step-code">${escapeHtml(key)}</div>` : '';
  return `<div class="step-name"><div class="step-title">${escapeHtml(title)}</div>${code}</div>`;
}

function dataKeyLabelText(key, fieldLabels = {}) {
  const title = dataKeyTitle(key, fieldLabels);
  return title !== key ? `${title}<br><small>${key}</small>` : title;
}

function orderedEntries(object, order = []) {
  const seen = new Set();
  const keys = [...order, ...Object.keys(object || {})].filter((key) => {
    if (!key || seen.has(key) || !(key in object)) return false;
    seen.add(key);
    return true;
  });
  return keys.map((key) => [key, object[key]]);
}

function compactRunData(result, fieldLabels = {}, fieldOrder = []) {
  const input = result.input || {};
  const ids = result.ids || {};
  const data = { ...input, ...ids };
  const parts = orderedEntries(data, fieldOrder)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .slice(0, 8)
    .map(([key, value]) => `${dataKeyTitle(key, fieldLabels)} ${value}`);
  return parts.join('；') || '-';
}

function failureAttempts(results, resultFiles) {
  return results
    .map((result, index) => ({
      result,
      file: resultFiles[index],
      index: index + 1,
    }))
    .filter(({ result }) => hasExecutionFailure(result));
}

function failureTypeBadge(result) {
  const failureType = result.failureType || '失败';
  return badgeHtml(failureType, failureType === '脏数据' ? 'red' : 'amber');
}

function sectionTitle(num, title) {
  return `<h2><span class="num">${escapeHtml(num)}</span>${escapeHtml(title)}</h2>`;
}

function tableHtml(headers, rows, className = '') {
  const classAttr = className ? ` class="${escapeHtml(className)}"` : '';
  const headerHtml = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('');
  const bodyHtml = rows
    .map((row) => '<tr>' + row.map((cell) => `<td>${cell}</td>`).join('') + '</tr>')
    .join('\n');
  return `<table${classAttr}>\n<thead><tr>${headerHtml}</tr></thead>\n<tbody>\n${bodyHtml}\n</tbody>\n</table>`;
}

function prettyJsonHtml(value) {
  return `<pre><code>${escapeHtml(JSON.stringify(value || {}, null, 2))}</code></pre>`;
}

function analysisListHtml(items, emptyText = '-') {
  const values = stringList(items);
  if (!values.length) return escapeHtml(emptyText);
  return `<ul>${values.map((item) => `<li>${inlineHtml(redact(item))}</li>`).join('')}</ul>`;
}

function networkEvidenceHtml(items) {
  if (!items.length) {
    return '<p class="note">未捕获到可确认关联的失败接口</p>';
  }
  return tableHtml(
    ['接口', 'x-trace-id', '分析摘要'],
    items.map((item) => [
      codeHtml(`${item.method} ${item.url}`),
      codeHtml(item.traceId || '未返回'),
      inlineHtml(item.summary),
    ]),
  );
}

function appendNetworkEvidenceMarkdown(lines, items, heading = '### 关键接口证据') {
  lines.push(heading);
  lines.push('');
  if (!items.length) {
    lines.push('未捕获到可确认关联的失败接口');
    return;
  }
  lines.push('| 接口 | x-trace-id | 分析摘要 |');
  lines.push('|---|---|---|');
  for (const item of items) {
    lines.push(`| ${markdownSafeCell(`${item.method} ${item.url}`)} | ${markdownSafeCell(item.traceId || '未返回')} | ${markdownSafeCell(item.summary)} |`);
  }
}

function failureAnalysisHtml(analysis, includeNetworkEvidence = true) {
  if (!analysis) return '<p class="note">本次执行未失败。</p>';
  const status = failureAnalysisStatusLabel(analysis.status);
  const repair = analysis.repair;
  const analysisTable = tableHtml(
    ['分析项', '内容'],
    [
      ['定位状态', badgeHtml(status, analysis.status === 'confirmed' ? 'red' : 'amber')],
      ['失败分类', badgeHtml(failureCategoryLabel(analysis.category), analysis.category === 'product-defect' ? 'red' : 'amber')],
      ['直接原因', inlineHtml(redact(analysis.directCause))],
      ['根因判断', inlineHtml(redact(analysis.rootCause))],
      ['判断证据', analysisListHtml(analysis.evidence, '未提供独立诊断证据。')],
      ['影响范围', inlineHtml(redact(analysis.impact))],
      ['处理建议', inlineHtml(redact(analysis.recommendation))],
      ['待补证据', analysisListHtml(analysis.missingEvidence, '无。')],
      ['自动修复轮次', `${repair.roundsUsed} / ${repair.maxAutomaticRounds}`],
      ['修复明细', repair.history.length ? analysisListHtml(repair.history.map((entry) => `第 ${entry.round} 轮：${entry.summary}；验证：${entry.verification}`)) : '无自动修复记录。'],
      ['最终停止原因', inlineHtml(redact(repair.stopReason))],
    ],
    'summary-table',
  );
  if (!includeNetworkEvidence) return analysisTable;
  return [analysisTable, '<h4>关键接口证据</h4>', networkEvidenceHtml(analysis.networkEvidence)].join('\n');
}

function blockerFailureAnalysis(finalResult, failureAnalysis) {
  return failureAnalysis || normalizeFailureAnalysis(finalResult, null);
}

function styledHtmlBody(ctx) {
  const { args, finalResult, rows, counts, conclusion, ids, artifacts, generatedAt, results, resultFiles, stepTitles, fieldLabels, fieldOrder, failureAnalysis } = ctx;
  const caseExecution = ctx.caseExecution
    || reconcileCaseStatuses(normalizeCaseExecution(results?.length ? results : [finalResult], args.caseIds || []), rows);
  const caseCounts = ctx.caseCounts || caseStatusCounts(caseExecution);
  const stepCaseMap = ctx.stepCaseMap || stepCaseMapForResults(results?.length ? results : [finalResult], caseExecution);
  const failedCaseIds = new Set(caseExecution.filter((item) => ['失败', '阻塞'].includes(item.status)).map((item) => item.caseId));
  const primaryFailure = ctx.primaryFailure
    || selectPrimaryFailureEvidence(finalResult, results || [], resultFiles || [], failedCaseIds, stepCaseMap);
  const failedResult = hasExecutionFailure(finalResult, rows);
  const success = conclusion === '可提测';
  const blockerAnalysis = success ? failureAnalysis : blockerFailureAnalysis(finalResult, failureAnalysis);
  const failedStep = stepLabelPlain(finalResult.failedStep, stepTitles);
  const failed = finalResult.failedStep ? `${failedStep}: ${firstLine(finalResult.error)}` : '无';
  const skipped = rows.filter((row) => row.status === '跳过').map((row) => row.name);
  const provedSkipped = rows.filter((row) => row.status === '跳过' && row.proof);
  const resumeEvidence = continuationEvidenceHtml(results || [], provedSkipped);
  const manual = finalResult.manualChecks || finalResult.manualFollowups || [];
  const command = redact(args.command || '');
  const resultLinks = fileLinkListHtml(ctx.resultFiles);
  const artifactList = artifacts.map((artifact) => `<li>${linkedPathHtml(artifact)}</li>`).join('\n');
  const cumulativeSuccess = (counts['成功'] || 0) + (counts['前序成功'] || 0);
  const caseById = new Map(caseExecution.map((item) => [item.caseId, item]));
  const testFlow = normalizeTestFlow(finalResult, caseExecution, rows);
  const caseIdSummary = testFlow.caseIds.join('、') || '无';

  const stepTable = tableHtml(
    ['步骤', '对应 Case', '累计状态', '执行耗时', '执行明细', '执行截图'],
    rows.map((row) => [
      stepNameHtml(row),
      caseRefsHtml(stepCaseMap[row.name] || [], caseById),
      stepStatusHtml(row),
      escapeHtml(row.durationText),
      inlineHtml(row.detail),
      stepEvidenceHtml(row),
    ]),
  );
  const idRows = orderedEntries(ids, fieldOrder).map(([key, value]) => [dataKeyLabelHtml(key, fieldLabels), inlineHtml(value)]);
  if (finalResult.selectedClassRow) idRows.push([dataKeyLabelHtml('selectedClassRow', fieldLabels), inlineHtml(finalResult.selectedClassRow)]);
  const idsTable = idRows.length
    ? tableHtml(['数据项', '值'], idRows)
    : '<p class="note">脚本未提供业务 ID 或输入数据。</p>';
  const relationBlocks = [];
  if (finalResult.pendingRelation) {
    relationBlocks.push('<p>成单前关系：</p>');
    relationBlocks.push(prettyJsonHtml(finalResult.pendingRelation));
  }
  if (finalResult.rewardedRelation) {
    relationBlocks.push('<p>成单后关系：</p>');
    relationBlocks.push(prettyJsonHtml(finalResult.rewardedRelation));
  }
  if (!relationBlocks.length) relationBlocks.push('<p class="note">脚本未提供关系快照。</p>');

  const failures = failureAttempts(results, resultFiles);
  const failureTable = failures.length
    ? tableHtml(
      ['轮次', '时间', '失败步骤', '分类', '错误摘要', '关键数据', '产物'],
      failures.map(({ result, file, index }) => [
        escapeHtml(`第 ${index} 次`),
        escapeHtml(formatResultTime(result.finishedAt || result.startedAt) || '-'),
        stepLabelHtml(result.failedStep, stepTitles),
        failureTypeBadge(result),
        escapeHtml(redact(firstLine(result.error) || '-')),
        escapeHtml(compactRunData(result, fieldLabels, fieldOrder)),
        [
          linkedPathHtml(file),
          result.screenshot ? linkedPathHtml(result.screenshot) : '',
        ].filter(Boolean).join('<br>'),
      ]),
    )
    : '<p class="note">没有失败轮次。</p>';

  const riskHtml = conclusion === '可提测'
    ? skipped.length
      ? `<div class="callout"><b>Resume 说明：</b>本次存在跳过步骤：${escapeHtml(skipped.join('、'))}。${resumeEvidence}</div>`
      : '<div class="callout"><b>风险结论：</b>未发现自动化失败。</div>'
    : [
      `<div class="callout red"><b>当前阻塞点：</b>${escapeHtml(primaryFailure.result?.failedStep ? `${stepLabelPlain(primaryFailure.result.failedStep, stepTitles)}: ${firstLine(primaryFailure.result.error)}` : failed)}<br/>失败分类：${escapeHtml(failureCategoryLabel(blockerAnalysis.category))}<br/>Resume 说明：${resumeEvidence}<br/>业务失败截图：${primaryFailure.screenshot ? linkedPathHtml(primaryFailure.screenshot) : '-'}</div>`,
      '<h3>完整受影响 Case</h3>',
      ...caseExecution.filter((item) => ['失败', '阻塞'].includes(item.status)).map((item) => `<div class="failed-case-detail">${caseDetailHtml(item)}</div>`),
      '<h3>问题原因分析</h3>',
      failureAnalysisHtml(blockerAnalysis, failedResult),
      '<h3>失败轮次明细</h3>',
      failureTable,
    ].join('\n');

  const manualHtml = manual.length
    ? tableHtml(
      ['来源', '项', '原因/建议'],
      manual.map((item) => [
        escapeHtml(item.source || '-'),
        escapeHtml(item.item || item.name || '-'),
        escapeHtml(item.reason || item.suggestion || '-'),
      ]),
    )
    : '<p class="note">脚本未声明额外人工验证项。</p>';

  const assertionSummary = finalAssertionSummary(finalResult);
  const primaryFailedStep = stepLabelPlain(primaryFailure.result?.failedStep || finalResult.failedStep, stepTitles);
  const oneLineConclusion = failedResult
    ? `本次自动化执行未通过，业务阻塞步骤为 ${escapeHtml(primaryFailedStep)}；直接原因：${escapeHtml(redact(blockerAnalysis.directCause))}；${escapeHtml(failureAnalysisStatusLabel(blockerAnalysis.status))}：${escapeHtml(redact(blockerAnalysis.rootCause))}`
    : success
      ? `本次自动化链路执行成功，${escapeHtml(assertionSummary)}`
      : `本次自动化结果未确认成功，${escapeHtml(assertionSummary)}`;
  const selectedCasesBlocked = caseExecution.length > 0
    && (caseCounts['失败'] || 0) === 0
    && ((caseCounts['阻塞'] || 0) > 0 || (caseCounts['未执行'] || 0) > 0);
  const executionStatus = success ? '成功' : selectedCasesBlocked ? '阻塞' : failedResult ? '失败' : '未知';
  const executionKind = executionStatus === '成功' ? 'green' : executionStatus === '阻塞' ? 'amber' : 'red';

  return [
    `<h1>${escapeHtml(ctx.title)}</h1>`,
    casePathHtml(ctx.casePath),
    `<div class="meta">生成时间：${escapeHtml(generatedAt)}；报告由 e2e-testing 自动生成，敏感信息已脱敏。</div>`,
    sectionTitle('0', '交付结论速览'),
    '<div class="verdict">',
    `<div class="card"><div class="t">能否提测</div><div class="v">${badgeHtml(conclusion)}</div></div>`,
    `<div class="card"><div class="t">测试流</div><div class="v">${escapeHtml(testFlow.title)}：Case ${testFlow.caseIds.length} 个 / 步骤 ${testFlow.stepKeys.length} 个<div class="card-note">${escapeHtml(testFlow.definition)}</div></div></div>`,
    `<div class="card"><div class="t">Case 执行</div><div class="v">目标 Case ${caseExecution.length} 个（${escapeHtml(caseIdSummary)}）：通过 ${caseCounts['通过'] || 0} / 失败 ${caseCounts['失败'] || 0} / 阻塞 ${caseCounts['阻塞'] || 0} / 未执行 ${caseCounts['未执行'] || 0}</div></div>`,
    `<div class="card"><div class="t">执行步骤</div><div class="v">${badgeHtml(executionStatus, executionKind)} 累计步骤 ${rows.length} 个：成功 ${cumulativeSuccess} / 失败 ${counts['失败'] || 0} / 本轮跳过 ${skipped.length} / 未开始 ${counts['未开始'] || 0}</div></div>`,
    `<div class="card"><div class="t">核心断言</div><div class="v">${escapeHtml(assertionSummary)}</div></div>`,
    `<div class="card"><div class="t">需人工兜底项</div><div class="v">${manual.length} 项脚本声明项</div></div>`,
    '</div>',
    `<div class="callout"><b>一句话结论：</b>${oneLineConclusion}</div>`,
    sectionTitle('1', '自动化执行结论（主体）'),
    tableHtml(
      ['项', '内容'],
      [
        ['用户描述', escapeHtml(redact(args.description || '-'))],
        ['匹配脚本', args.script ? linkedPathHtml(path.resolve(args.script)) : '-'],
        ['执行命令', codeBlockHtml(command || '-')],
        ['Base URL', `<span class="url-text">${escapeHtml(finalResult.baseUrl || '-')}</span>`],
        ['结果 JSON', resultLinks],
      ],
      'summary-table',
    ),
    '<h3>Case 执行结果</h3>',
    caseExecutionTableHtml(caseExecution, stepTitles),
    '<h3>执行步骤与 Case 对应</h3>',
    stepTable,
    '<h3>执行录屏</h3>',
    videoRecordingHtml(results?.length ? results : [finalResult]),
    sectionTitle('2', '业务链路覆盖'),
    idsTable,
    sectionTitle('3', '全链路回归快照'),
    ...relationBlocks,
    sectionTitle('4', '失败 / 阻塞 / 风险'),
    riskHtml,
    sectionTitle('5', '需人工验证 / 测不到项清单'),
    manualHtml,
    sectionTitle('6', '源报告与产物反查'),
    artifactList ? `<ul>\n${artifactList}\n</ul>` : '<p class="note">无源产物。</p>',
    sectionTitle('7', '原始输入与结果摘要'),
    prettyJsonHtml({
      input: finalResult.input,
      ids: finalResult.ids,
      ok: finalResult.ok,
      failedStep: finalResult.failedStep,
      resultFiles: ctx.resultFiles.map(fileLabel),
    }),
  ].join('\n');
}

function markdownReport(ctx) {
  const { args, finalResult, results, rows, counts, conclusion, ids, artifacts, generatedAt, resultFiles, stepTitles, fieldLabels, fieldOrder, failureAnalysis } = ctx;
  const title = ctx.title;
  const failedStep = stepLabelPlain(finalResult.failedStep, stepTitles);
  const failed = finalResult.failedStep ? `${failedStep}: ${firstLine(finalResult.error)}` : '无';
  const relation = finalResult.rewardedRelation || finalResult.pendingRelation || null;
  const command = redact(args.command || '');
  const cumulativeSuccess = (counts['成功'] || 0) + (counts['前序成功'] || 0);
  const skipped = rows.filter((row) => row.status === '跳过').map((row) => row.name);
  const failedResult = hasExecutionFailure(finalResult, rows);
  const success = finalResult.ok === true && !failedResult;
  const blockerAnalysis = success ? failureAnalysis : blockerFailureAnalysis(finalResult, failureAnalysis);

  const lines = [];
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`生成时间：${generatedAt}`);
  lines.push('');
  lines.push('## 0. 交付结论速览');
  lines.push('');
  lines.push(`- 能否提测：**${conclusion}**`);
  lines.push(`- 自动化结果：${success ? '成功' : failedResult ? '失败' : '未知'}`);
  lines.push(`- 步骤统计：累计成功 ${cumulativeSuccess} / 失败 ${counts['失败'] || 0} / 本轮跳过 ${skipped.length} / 未开始 ${counts['未开始'] || 0}`);
  lines.push(`- 失败/阻塞：${failed}`);
  lines.push(`- 核心断言：${finalAssertionSummary(finalResult)}`);
  lines.push('');
  lines.push('## 1. 自动化执行结论（主体）');
  lines.push('');
  lines.push(`- 用户描述：${redact(args.description || '-')}`);
  lines.push(`- 匹配脚本：${args.script ? fileLabel(args.script) : '-'}`);
  lines.push(`- 执行命令：${command || '-'}`);
  lines.push(`- Base URL：${finalResult.baseUrl || '-'}`);
  lines.push(`- 结果 JSON：${ctx.resultFiles.map(fileLabel).join('；') || '-'}`);
  lines.push('');
  lines.push('| 步骤 | 累计状态 | 执行耗时 | 执行明细 |');
  lines.push('|---|---|---|---|');
  for (const row of rows) {
    const name = row.title ? `${row.title}<br><small>${row.name}</small>` : row.name;
    const status = row.displayStatus && row.displayStatus !== row.status
      ? `${row.displayStatus}<br><small>本轮状态：${row.status}</small>`
      : row.status;
    lines.push(`| ${mdCell(name)} | ${mdCell(status)} | ${mdCell(row.durationText)} | ${mdCell(row.detail)} |`);
  }
  lines.push('');
  lines.push('## 2. 业务链路覆盖');
  lines.push('');
  lines.push('| 数据项 | 值 |');
  lines.push('|---|---|');
  for (const [key, value] of orderedEntries(ids, fieldOrder)) {
    lines.push(`| ${mdCell(dataKeyLabelText(key, fieldLabels))} | ${mdCell(value)} |`);
  }
  if (finalResult.selectedClassRow) lines.push(`| ${mdCell(dataKeyLabelText('selectedClassRow', fieldLabels))} | ${mdCell(finalResult.selectedClassRow)} |`);
  lines.push('');
  lines.push('## 3. 全链路回归快照');
  lines.push('');
  if (finalResult.pendingRelation) {
    lines.push('成单前关系：');
    lines.push(formatJsonBlock(finalResult.pendingRelation));
  }
  if (finalResult.rewardedRelation) {
    lines.push('成单后关系：');
    lines.push(formatJsonBlock(finalResult.rewardedRelation));
  }
  if (!finalResult.pendingRelation && !finalResult.rewardedRelation && relation) {
    lines.push(formatJsonBlock(relation));
  }
  if (!relation && !finalResult.pendingRelation && !finalResult.rewardedRelation) {
    lines.push('脚本未提供关系快照。');
  }
  lines.push('');
  lines.push('## 4. 失败 / 阻塞 / 风险');
  lines.push('');
  if (!failedResult) {
    const skipped = rows.filter((row) => row.status === '跳过').map((row) => row.name);
    if (skipped.length) {
      lines.push(`- 本次存在 resume 跳过步骤：${skipped.join('、')}。需结合前序结果 JSON 反查这些不可逆步骤。`);
    } else {
      lines.push('- 未发现自动化失败。');
    }
  } else {
    lines.push(`- 当前阻塞步骤：${failedStep}`);
    lines.push(`- 失败分类：${finalResult.failureType || '-'}`);
    lines.push(`- 错误摘要：${firstLine(finalResult.error) || '-'}`);
    lines.push(`- 截图：${finalResult.screenshot || '-'}`);
    lines.push('');
    lines.push('### 问题原因分析');
    lines.push('');
    lines.push(`- 定位状态：${failureAnalysisStatusLabel(blockerAnalysis.status)}`);
    lines.push(`- 直接原因：${redact(blockerAnalysis.directCause)}`);
    lines.push(`- 根因判断：${redact(blockerAnalysis.rootCause)}`);
    lines.push(`- 判断证据：${blockerAnalysis.evidence.map(redact).join('；') || '未提供独立诊断证据。'}`);
    lines.push(`- 影响范围：${redact(blockerAnalysis.impact)}`);
    lines.push(`- 处理建议：${redact(blockerAnalysis.recommendation)}`);
    lines.push(`- 待补证据：${blockerAnalysis.missingEvidence.map(redact).join('；') || '无。'}`);
    lines.push('');
    appendNetworkEvidenceMarkdown(lines, blockerAnalysis.networkEvidence);
    lines.push('');
    lines.push('### 失败轮次明细');
    lines.push('');
    const failures = failureAttempts(results, resultFiles);
    if (failures.length) {
      lines.push('| 轮次 | 时间 | 失败步骤 | 分类 | 错误摘要 | 关键数据 | 产物 |');
      lines.push('|---|---|---|---|---|---|---|');
      for (const { result, file, index } of failures) {
        const artifactsForRun = [file, result.screenshot].filter(Boolean).map(fileLabel).join('<br>');
        lines.push(`| 第 ${index} 次 | ${mdCell(formatResultTime(result.finishedAt || result.startedAt) || '-')} | ${mdCell(stepLabelText(result.failedStep, stepTitles))} | ${mdCell(result.failureType || '失败')} | ${mdCell(redact(firstLine(result.error) || '-'))} | ${mdCell(compactRunData(result, fieldLabels, fieldOrder))} | ${mdCell(artifactsForRun)} |`);
      }
    } else {
      lines.push('- 没有失败轮次。');
    }
  }
  lines.push('');
  lines.push('## 5. 需人工验证 / 测不到项清单');
  lines.push('');
  const manual = finalResult.manualChecks || finalResult.manualFollowups || [];
  if (manual.length) {
    lines.push('| 来源 | 项 | 原因/建议 |');
    lines.push('|---|---|---|');
    for (const item of manual) {
      lines.push(`| ${mdCell(item.source || '-')} | ${mdCell(item.item || item.name || '-')} | ${mdCell(item.reason || item.suggestion || '-')} |`);
    }
  } else {
    lines.push('- 脚本未声明额外人工验证项。');
  }
  lines.push('');
  lines.push('## 6. 源报告与产物反查');
  lines.push('');
  for (const artifact of artifacts) lines.push(`- ${fileLabel(artifact)}`);
  lines.push('');
  lines.push('## 7. 原始输入与结果摘要');
  lines.push('');
  lines.push(formatJsonBlock({
    input: finalResult.input,
    ids: finalResult.ids,
    ok: finalResult.ok,
    failedStep: finalResult.failedStep,
    resultFiles: ctx.resultFiles.map(fileLabel),
  }));
  return lines.join('\n');
}

function extractStyleBlock(file) {
  if (!file) return '';
  const source = fs.readFileSync(file, 'utf8');
  const match = source.match(/<style\b[^>]*>[\s\S]*?<\/style>/i);
  if (!match) throw new Error(`No <style> block found in ${file}`);
  return match[0];
}

function defaultStyleBlock() {
  return `<style>
  :root {
    --green:#0c7b6b; --green-bg:#ecfdf5; --amber:#b45309; --amber-bg:#fff7ed;
    --red:#b91c1c; --red-bg:#fef2f2; --ink:#111827; --sub:#5d6675; --line:#e5e7eb; --blue:#1d4ed8;
  }
  *{box-sizing:border-box}
  body{margin:0;padding:32px 16px;font-family:"PingFang SC",Inter,Roboto,system-ui,-apple-system,sans-serif;color:var(--ink);background:#f8fafc;line-height:1.7}
  .wrap{max-width:1180px;margin:0 auto;background:#fff;border:1px solid var(--line);border-radius:14px;padding:36px 40px;box-shadow:0 1px 3px rgba(0,0,0,.04)}
  h1{font-size:26px;margin:0 0 4px}
  .case-path{color:var(--sub);font-size:12px;line-height:1.5;margin:0 0 4px}
  .case-path code{font-size:12px;color:var(--sub)}
  .meta{color:var(--sub);font-size:13px;margin-bottom:24px}
  h2{font-size:19px;margin:34px 0 12px;padding-bottom:8px;border-bottom:2px solid var(--line)}
  h2 .num{color:var(--blue);margin-right:8px}
  h3{font-size:15px;margin:18px 0 8px}
  ul{padding-left:20px;margin:8px 0}
  li{margin:4px 0}
  table{width:100%;border-collapse:collapse;margin:12px 0;font-size:14px}
  th,td{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top;overflow-wrap:anywhere}
  th{background:#f1f5f9;font-weight:600}
  .summary-table th:first-child,.summary-table td:first-child{width:96px;white-space:nowrap}
  .badge{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap}
  .b-green{color:var(--green);background:var(--green-bg)}
  .b-amber{color:var(--amber);background:var(--amber-bg)}
  .b-red{color:var(--red);background:var(--red-bg)}
  .step-name{display:flex;flex-direction:column;gap:2px}
  .step-title{font-weight:600;color:var(--ink)}
  .step-code,.step-note{font-size:12px;color:var(--sub);line-height:1.45}
  .step-screenshot-link{display:block;width:180px;max-width:100%}
  .step-screenshot{display:block;width:180px;max-width:100%;height:108px;object-fit:contain;border:1px solid var(--line);background:#f8fafc}
  .step-video-list{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
  .step-video-link{display:inline-block;color:var(--blue);font-size:12px;text-decoration:none;border:1px solid var(--line);border-radius:999px;padding:2px 8px;background:#fff}
  .evidence-missing{color:var(--red);font-size:12px;font-weight:600}
  .case-title-cell{display:flex;align-items:flex-start;gap:10px;min-width:220px}
  .case-refs{display:flex;flex-wrap:wrap;gap:6px}
  .case-hover{position:relative;display:inline-block;outline:none}
  .case-hover:focus>.badge{box-shadow:0 0 0 3px rgba(29,78,216,.2)}
  .case-tooltip{display:none;position:absolute;z-index:20;left:0;top:calc(100% + 8px);width:min(430px,80vw);max-height:60vh;overflow:auto;padding:14px 16px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--ink);box-shadow:0 12px 30px rgba(15,23,42,.18);font-size:13px;font-weight:400;line-height:1.55;white-space:normal}
  .case-hover:hover>.case-tooltip,.case-hover:focus>.case-tooltip,.case-hover:focus-within>.case-tooltip{display:block}
  .case-detail-title{font-weight:700;margin-bottom:8px}
  .case-detail-row{margin:7px 0}
  .case-detail-row ol{margin:4px 0 0;padding-left:20px}
  .case-step-list{display:flex;flex-direction:column;gap:7px;min-width:210px}
  .failed-case-detail{border:1px solid #fecaca;background:#fff;padding:12px 14px;margin:10px 0}
  .path-link{color:inherit;text-decoration:none;cursor:pointer;display:inline-block;max-width:100%}
  .path-link code{white-space:normal;overflow-wrap:anywhere}
  .file-list{display:flex;flex-wrap:wrap;gap:6px 8px}
  .url-text{overflow-wrap:anywhere}
  .cmd-block{margin:0;background:#f8fafc;color:var(--ink);border:1px solid var(--line);padding:10px 12px;border-radius:6px;white-space:pre-wrap;overflow-wrap:anywhere}
  .cmd-block code{background:transparent;color:inherit;padding:0;white-space:pre-wrap;overflow-wrap:anywhere}
  .verdict{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0}
  .card{flex:1 1 220px;border:1px solid var(--line);border-radius:10px;padding:14px 16px}
  .card .t{font-size:12px;color:var(--sub);margin-bottom:4px}
  .card .v{font-size:14px;font-weight:600}
  .card-note{margin-top:4px;color:var(--sub);font-size:11px;font-weight:400;line-height:1.45}
  .callout{border-left:4px solid var(--amber);background:var(--amber-bg);padding:12px 16px;border-radius:0 8px 8px 0;margin:12px 0;font-size:14px}
  .callout.red{border-color:var(--red);background:var(--red-bg)}
  code{background:#f1f5f9;padding:1px 6px;border-radius:4px;font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  pre{overflow:auto;background:#111827;color:#e5e7eb;padding:14px;border-radius:6px}
  pre code{background:transparent;color:inherit;padding:0}
  .note{color:var(--sub);font-size:13px}
  @media (max-width:720px){body{padding:12px 8px}.wrap{padding:22px 16px;border-radius:8px}.card{flex-basis:100%}th,td{min-width:130px}.summary-table th:first-child,.summary-table td:first-child{min-width:92px}.case-tooltip{position:fixed;left:5vw;right:5vw;top:15vh;width:90vw;max-height:70vh}}
</style>`;
}

function htmlReport(ctx, markdown) {
  const body = styledHtmlBody(ctx);
  const styleBlock = ctx.args.styleSourceHtml
    ? extractStyleBlock(ctx.args.styleSourceHtml)
    : defaultStyleBlock();
  const wrappedBody = `<div class="wrap">${body}</div>`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(ctx.title)}</title>
  ${styleBlock}
</head>
<body>${wrappedBody}</body>
</html>
`;
}

function resolveFrom(baseDir, file) {
  if (!file) return '';
  return path.resolve(baseDir, file);
}

function normalizeManifestRuns(manifest, manifestFile) {
  const baseDir = path.dirname(path.resolve(manifestFile));
  const runs = manifest.runs || manifest.results || manifest.scripts;
  if (!Array.isArray(runs) || !runs.length) {
    throw new Error('Manifest must contain a non-empty runs array');
  }

  return runs.map((run, index) => {
    const resultJson = Array.isArray(run.resultJson)
      ? run.resultJson
      : Array.isArray(run.resultJsons)
        ? run.resultJsons
        : Array.isArray(run.result_json)
          ? run.result_json
          : [run.resultJson || run.result_json].filter(Boolean);
    if (!resultJson.length) throw new Error(`Manifest run #${index + 1} is missing resultJson`);
    return {
      name: run.name || run.title || run.case || `脚本 ${index + 1}`,
      script: run.script ? resolveFrom(baseDir, run.script) : '',
      command: run.command || '',
      log: run.log ? resolveFrom(baseDir, run.log) : '',
      failureAnalysisFile: run.failureAnalysis || run.failure_analysis
        ? resolveFrom(baseDir, run.failureAnalysis || run.failure_analysis)
        : '',
      resultFiles: resultJson.map((file) => resolveFrom(baseDir, file)),
    };
  });
}

function runContextFromManifestRun(run) {
  const results = run.resultFiles.map((file) => redactJsonValue(readJson(file)));
  const finalResult = results[results.length - 1];
  const explicitFailureAnalysis = run.failureAnalysisFile ? readJson(run.failureAnalysisFile) : null;
  const scriptMeta = loadScriptReportMeta(run.script);
  const resultMeta = loadResultReportMeta(results);
  const stepTitles = { ...scriptMeta.stepTitles, ...resultMeta.stepTitles };
  const fieldLabels = { ...scriptMeta.fieldLabels, ...resultMeta.fieldLabels };
  const fieldOrder = mergeFieldOrder(resultMeta.fieldOrder, scriptMeta.fieldOrder);
  const rows = enrichStepRows(stepRows(finalResult, stepTitles, results, run.resultFiles), finalResult);
  const counts = countStatuses(rows);
  const failed = hasExecutionFailure(finalResult, rows);
  const failureAnalysis = requiresFailureAnalysis(finalResult, rows)
    ? normalizeFailureAnalysis(finalResult, explicitFailureAnalysis)
    : null;
  const conclusion = finalConclusion(finalResult, rows, results, failureAnalysis);
  const artifacts = summarizeArtifacts({ script: run.script, log: run.log, failureAnalysis: run.failureAnalysisFile }, run.resultFiles, results);
  return {
    ...run,
    results,
    finalResult,
    stepTitles,
    fieldLabels,
    fieldOrder,
    rows,
    counts,
    failed,
    conclusion,
    artifacts,
    failureAnalysis,
  };
}

function aggregateConclusion(runContexts) {
  if (runContexts.some((run) => run.conclusion === '不可提测')) return '不可提测';
  if (runContexts.some((run) => run.conclusion === '执行阻塞')) return '执行阻塞';
  return '可提测';
}

function aggregateArtifacts(runContexts) {
  return [...new Set(runContexts.flatMap((run) => run.artifacts).filter(Boolean))];
}

function aggregateIds(runContexts) {
  const { fieldOrder } = aggregateFieldMeta(runContexts);
  return collectIds(runContexts.flatMap((run) => run.results), fieldOrder);
}

function aggregateFieldMeta(runContexts) {
  const labels = {};
  const order = [];
  for (const run of runContexts) {
    Object.assign(labels, run.fieldLabels);
    order.push(...run.fieldOrder);
  }
  return {
    fieldLabels: labels,
    fieldOrder: mergeFieldOrder(order),
  };
}

function aggregateRunStatusText(run) {
  return `成功 ${run.counts['成功'] || 0} / 失败 ${run.counts['失败'] || 0} / 跳过 ${run.counts['跳过'] || 0} / 未开始 ${run.counts['未开始'] || 0}；${finalAssertionSummary(run.finalResult)}`;
}

function aggregateRunKeyData(run) {
  const ids = collectIds(run.results, run.fieldOrder);
  return compactObjectHtml(ids, run.fieldLabels, run.fieldOrder);
}

function compactObjectHtml(object, fieldLabels = {}, fieldOrder = []) {
  const rows = orderedEntries(object, fieldOrder)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => [dataKeyLabelHtml(key, fieldLabels), inlineHtml(value)]);
  return rows.length ? tableHtml(['数据项', '值'], rows) : '<p class="note">无关键数据。</p>';
}

function aggregateFailureHtml(runContexts) {
  const failures = [];
  for (const run of runContexts) {
    for (const item of failureAttempts(run.results, run.resultFiles)) {
      failures.push({ run, ...item });
    }
  }
  if (!failures.length) {
    return runContexts.some((run) => run.conclusion !== '可提测')
      ? '<p class="note">没有执行失败轮次；阻塞原因见问题原因分析。</p>'
      : '<div class="callout"><b>风险结论：</b>未发现自动化失败。</div>';
  }
  return tableHtml(
    ['链路', '轮次', '时间', '失败步骤', '分类', '错误摘要', '产物'],
    failures.map(({ run, result, file, index }) => [
      escapeHtml(run.name),
      escapeHtml(`第 ${index} 次`),
      escapeHtml(formatResultTime(result.finishedAt || result.startedAt) || '-'),
      stepLabelHtml(result.failedStep, run.stepTitles),
      failureTypeBadge(result),
      escapeHtml(redact(firstLine(result.error) || '-')),
      [
        linkedPathHtml(file),
        result.screenshot ? linkedPathHtml(result.screenshot) : '',
      ].filter(Boolean).join('<br>'),
    ]),
  );
}

function aggregateFailureAnalysisHtml(runContexts) {
  const blockedRuns = runContexts.filter((run) => run.conclusion !== '可提测');
  if (!blockedRuns.length) return '<p class="note">没有失败或阻塞链路。</p>';
  return blockedRuns.map((run) => [
    `<h3>${escapeHtml(run.name)}</h3>`,
    failureAnalysisHtml(run.failureAnalysis, run.failed),
  ].join('\n')).join('\n');
}

function aggregateHtmlReport(ctx) {
  const { args, title, description, runContexts, conclusion, generatedAt } = ctx;
  const styleBlock = args.styleSourceHtml
    ? extractStyleBlock(args.styleSourceHtml)
    : defaultStyleBlock();
  const successRuns = runContexts.filter((run) => run.conclusion === '可提测').length;
  const failedRuns = runContexts.length - successRuns;
  const allArtifacts = aggregateArtifacts(runContexts);
  const { fieldLabels, fieldOrder } = aggregateFieldMeta(runContexts);
  const ids = aggregateIds(runContexts);
  const overviewRows = runContexts.map((run) => [
    escapeHtml(run.name),
    badgeHtml(run.conclusion),
    badgeHtml(run.conclusion === '可提测' ? '成功' : run.failed ? '失败' : '未知', run.conclusion === '可提测' ? 'green' : 'red'),
    escapeHtml(aggregateRunStatusText(run)),
    aggregateRunKeyData(run),
    codeBlockHtml(redact(run.command || '-')),
    fileLinkListHtml(run.resultFiles),
  ]);
  const chainBlocks = runContexts.map((run, index) => [
    `<h3>${escapeHtml(`${index + 1}. ${run.name}`)}</h3>`,
    tableHtml(
      ['步骤', '累计状态', '执行耗时', '执行明细'],
      run.rows.map((row) => [
        stepNameHtml(row),
        stepStatusHtml(row),
        escapeHtml(row.durationText),
        inlineHtml(row.detail),
      ]),
    ),
  ].join('\n')).join('\n');
  const artifactsHtml = allArtifacts.length
    ? `<ul>\n${allArtifacts.map((artifact) => `<li>${linkedPathHtml(artifact)}</li>`).join('\n')}\n</ul>`
    : '<p class="note">无源产物。</p>';

  const body = [
    `<h1>${escapeHtml(title)}</h1>`,
    `<div class="meta">生成时间：${escapeHtml(generatedAt)}；报告由 e2e-testing 汇总生成，敏感信息已脱敏。</div>`,
    sectionTitle('0', '交付结论速览'),
    '<div class="verdict">',
    `<div class="card"><div class="t">能否提测</div><div class="v">${badgeHtml(conclusion)}</div></div>`,
    `<div class="card"><div class="t">自动化链路</div><div class="v">共 ${runContexts.length} 条，成功 ${successRuns} 条，失败 ${failedRuns} 条</div></div>`,
    `<div class="card"><div class="t">源产物</div><div class="v">${allArtifacts.length} 个可反查文件</div></div>`,
    '</div>',
    `<div class="callout"><b>一句话结论：</b>${conclusion === '可提测' ? '本次多脚本自动化链路均执行成功。' : '本次多脚本自动化链路存在失败或需人工确认项。'}</div>`,
    sectionTitle('1', '自动化执行结论（主体）'),
    tableHtml(
      ['项', '内容'],
      [
        ['用户描述', escapeHtml(redact(description || '-'))],
        ['执行清单', escapeHtml(runContexts.map((run) => run.name).join('；'))],
      ],
      'summary-table',
    ),
    tableHtml(
      ['链路', '结论', '结果', '步骤统计', '关键数据', '执行命令', '结果 JSON'],
      overviewRows,
    ),
    sectionTitle('2', '关键业务数据汇总'),
    compactObjectHtml(ids, fieldLabels, fieldOrder),
    sectionTitle('3', '分链路步骤明细'),
    chainBlocks,
    sectionTitle('4', '失败 / 阻塞 / 风险'),
    '<h3>问题原因分析</h3>',
    aggregateFailureAnalysisHtml(runContexts),
    '<h3>失败轮次明细</h3>',
    aggregateFailureHtml(runContexts),
    sectionTitle('5', '源报告与产物反查'),
    artifactsHtml,
    sectionTitle('6', '原始输入与结果摘要'),
    prettyJsonHtml({
      conclusion,
      runs: runContexts.map((run) => ({
        name: run.name,
        ok: run.finalResult.ok,
        failedStep: run.finalResult.failedStep,
        resultFiles: run.resultFiles.map(fileLabel),
      })),
    }),
  ].join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  ${styleBlock}
</head>
<body><div class="wrap">${body}</div></body>
</html>
`;
}

function aggregateMarkdownReport(ctx) {
  const lines = [];
  lines.push(`# ${ctx.title}`);
  lines.push('');
  lines.push(`生成时间：${ctx.generatedAt}`);
  lines.push('');
  lines.push(`- 能否提测：${ctx.conclusion}`);
  lines.push(`- 用户描述：${redact(ctx.description || '-')}`);
  lines.push(`- 链路数量：${ctx.runContexts.length}`);
  lines.push('');
  lines.push('| 链路 | 结论 | 结果 | 步骤统计 | 结果 JSON |');
  lines.push('|---|---|---|---|---|');
  for (const run of ctx.runContexts) {
    lines.push(`| ${mdCell(run.name)} | ${mdCell(run.conclusion)} | ${mdCell(run.finalResult.ok === true && !run.failed ? '成功' : run.failed ? '失败' : '未知')} | ${mdCell(aggregateRunStatusText(run))} | ${mdCell(run.resultFiles.map(fileLabel).join('<br>'))} |`);
  }
  const failedRuns = ctx.runContexts.filter((run) => run.failureAnalysis);
  if (failedRuns.length) {
    lines.push('');
    lines.push('## 问题原因分析');
    for (const run of failedRuns) {
      const analysis = run.failureAnalysis;
      lines.push('');
      lines.push(`### ${run.name}`);
      lines.push(`- 定位状态：${failureAnalysisStatusLabel(analysis.status)}`);
      lines.push(`- 直接原因：${redact(analysis.directCause)}`);
      lines.push(`- 根因判断：${redact(analysis.rootCause)}`);
      lines.push(`- 判断证据：${analysis.evidence.map(redact).join('；') || '未提供独立诊断证据。'}`);
      lines.push(`- 影响范围：${redact(analysis.impact)}`);
      lines.push(`- 处理建议：${redact(analysis.recommendation)}`);
      lines.push(`- 待补证据：${analysis.missingEvidence.map(redact).join('；') || '无。'}`);
      lines.push('');
      appendNetworkEvidenceMarkdown(lines, analysis.networkEvidence, '#### 关键接口证据');
    }
  }
  return lines.join('\n');
}

function markdownToHtml(markdown) {
  const lines = markdown.split(/\r?\n/);
  const html = [];
  let inCode = false;
  let inUl = false;
  let table = [];

  const flushTable = () => {
    if (!table.length) return;
    const rows = table.filter((line) => !/^\|\s*-+/.test(line));
    html.push('<table>');
    rows.forEach((line, index) => {
      const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
      const tag = index === 0 ? 'th' : 'td';
      html.push('<tr>' + cells.map((cell) => `<${tag}>${inlineHtml(cell)}</${tag}>`).join('') + '</tr>');
    });
    html.push('</table>');
    table = [];
  };
  const closeUl = () => {
    if (inUl) {
      html.push('</ul>');
      inUl = false;
    }
  };

  for (const line of lines) {
    if (line.startsWith('```')) {
      flushTable();
      closeUl();
      if (!inCode) {
        inCode = true;
        html.push('<pre><code>');
      } else {
        inCode = false;
        html.push('</code></pre>');
      }
      continue;
    }
    if (inCode) {
      html.push(escapeHtml(line));
      continue;
    }
    if (/^\|.*\|$/.test(line)) {
      closeUl();
      table.push(line);
      continue;
    }
    flushTable();
    if (line.startsWith('# ')) {
      closeUl();
      html.push(`<h1>${inlineHtml(line.slice(2))}</h1>`);
    } else if (line.startsWith('## ')) {
      closeUl();
      html.push(`<h2>${inlineHtml(line.slice(3))}</h2>`);
    } else if (line.startsWith('- ')) {
      if (!inUl) {
        html.push('<ul>');
        inUl = true;
      }
      html.push(`<li>${inlineHtml(line.slice(2))}</li>`);
    } else if (line.trim()) {
      closeUl();
      html.push(`<p>${inlineHtml(line)}</p>`);
    } else {
      closeUl();
    }
  }
  flushTable();
  closeUl();
  return html.join('\n');
}

function firstLine(value) {
  return String(value || '').split('\n')[0];
}

function padNumber(value, length = 2) {
  return String(value).padStart(length, '0');
}

function localOffset(date) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return `${sign}${padNumber(Math.floor(abs / 60))}:${padNumber(abs % 60)}`;
}

function localTimeZoneName(date) {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
      .formatToParts(date)
      .find((item) => item.type === 'timeZoneName');
    return part && part.value ? part.value : '';
  } catch {
    return '';
  }
}

function formatLocalDateTime(date) {
  const timestamp = [
    date.getFullYear(),
    padNumber(date.getMonth() + 1),
    padNumber(date.getDate()),
  ].join('-') + ' ' + [
    padNumber(date.getHours()),
    padNumber(date.getMinutes()),
    padNumber(date.getSeconds()),
  ].join(':') + `.${padNumber(date.getMilliseconds(), 3)}`;
  return `${timestamp} ${localTimeZoneName(date)} ${localOffset(date)}`.replace(/\s+/g, ' ').trim();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (args.manifest) {
    generateAggregateReport(args);
    return;
  }
  if (!args.resultJson.length) throw new Error('At least one --result-json is required');

  if (args.script) assertCanonicalCaseInputFile(args.script, 'script.js', true);
  const resultFiles = args.resultJson.map((file) => path.resolve(file));
  for (const resultFile of resultFiles) assertCanonicalCaseInputFile(resultFile, 'result.json', false);
  const results = resultFiles.map((file) => redactJsonValue(readJson(file)));
  const finalResult = results[results.length - 1];
  const explicitFailureAnalysis = args.failureAnalysis ? readJson(path.resolve(args.failureAnalysis)) : null;
  const scriptMeta = loadScriptReportMeta(args.script);
  const resultMeta = loadResultReportMeta(results);
  const stepTitles = { ...scriptMeta.stepTitles, ...resultMeta.stepTitles };
  const fieldLabels = { ...scriptMeta.fieldLabels, ...resultMeta.fieldLabels };
  const fieldOrder = mergeFieldOrder(resultMeta.fieldOrder, scriptMeta.fieldOrder);
  let caseExecution = normalizeCaseExecution(results, args.caseIds, scriptMeta.caseDefinitions);
  const rows = enrichStepRows(
    caseExecution.length
      ? combinedStepRows(results, resultFiles, stepTitles, caseExecution, finalResult.testFlow?.stepKeys || [])
      : stepRows(finalResult, stepTitles, results, resultFiles),
    finalResult,
  );
  caseExecution = reconcileCaseStatuses(caseExecution, rows);
  const caseCounts = caseStatusCounts(caseExecution);
  const stepCaseMap = stepCaseMapForResults(results, caseExecution);
  const failedCaseIds = new Set(caseExecution.filter((item) => ['失败', '阻塞'].includes(item.status)).map((item) => item.caseId));
  const primaryFailure = selectPrimaryFailureEvidence(finalResult, results, resultFiles, failedCaseIds, stepCaseMap, explicitFailureAnalysis);
  const counts = countStatuses(rows);
  const failed = hasExecutionFailure(finalResult, rows);
  const failureAnalysis = requiresFailureAnalysis(finalResult, rows)
    ? normalizeFailureAnalysis(primaryFailure.result || finalResult, explicitFailureAnalysis)
    : null;
  const conclusion = finalConclusion(finalResult, rows, results, failureAnalysis, caseExecution.length ? caseCounts : null);
  const ids = collectIds(results, fieldOrder);
  const outDir = resolveSingleCaseDir(args, finalResult, resultFiles);
  assertExplicitOutDir(args.outDir, outDir);
  ensureDefaultOutDir(outDir, 'cases');

  const generatedDate = new Date();
  const generatedAt = formatLocalDateTime(generatedDate);
  const presentation = resolveCasePresentation(args, finalResult, resultFiles, outDir);
  const title = presentation.title;
  const artifacts = summarizeArtifacts(args, resultFiles, results);
  const ctx = {
    args,
    finalResult,
    results,
    rows,
    counts,
    failed,
    conclusion,
    ids,
    artifacts,
    resultFiles,
    stepTitles,
    fieldLabels,
    fieldOrder,
    failureAnalysis,
    generatedAt,
    title,
    casePath: presentation.casePath,
    caseExecution,
    caseCounts,
    stepCaseMap,
    primaryFailure,
    logText: readTextIfExists(args.log),
  };

  const html = htmlReport(ctx);
  const htmlFile = path.join(outDir, 'report.html');
  writeCanonicalReport(htmlFile, html);

  console.log('========== 测试报告生成结果 ==========');
  console.log('结论: ' + conclusion);
  console.log('HTML: ' + htmlFile);
  console.log('结果JSON: ' + resultFiles.join(', '));
  if (args.failureAnalysis) console.log('失败分析: ' + path.resolve(args.failureAnalysis));
  console.log('======================================');
}

function generateAggregateReport(args) {
  const manifestFile = path.resolve(args.manifest);
  const manifest = readJson(manifestFile);
  const manifestRuns = normalizeManifestRuns(manifest, manifestFile);
  const outDir = aggregateCaseDir(manifestRuns);
  assertExplicitOutDir(args.outDir, outDir);
  ensureDefaultOutDir(outDir, 'cases');
  const runContexts = manifestRuns.map(runContextFromManifestRun);
  const conclusion = aggregateConclusion(runContexts);

  const generatedDate = new Date();
  const generatedAt = formatLocalDateTime(generatedDate);
  const title = args.title || manifest.title || '需求交付测试报告 · 自动化执行汇总';
  const description = args.description || manifest.description || '';
  const ctx = {
    args,
    manifestFile,
    manifest,
    runContexts,
    conclusion,
    generatedAt,
    title,
    description,
  };
  const html = aggregateHtmlReport(ctx);
  const htmlFile = path.join(outDir, 'report.html');
  writeCanonicalReport(htmlFile, html);

  console.log('========== 汇总测试报告生成结果 ==========');
  console.log('结论: ' + conclusion);
  console.log('HTML: ' + htmlFile);
  console.log('Manifest: ' + manifestFile);
  console.log('结果JSON: ' + runContexts.flatMap((run) => run.resultFiles).join(', '));
  console.log('==========================================');
}

function canonicalCaseDirFromResult(resultFile) {
  if (!resultFile || path.basename(resultFile) !== 'result.json') return '';
  const workspace = fs.realpathSync(process.cwd());
  const casesRoot = path.join(workspace, 'worktree', 'cases');
  const caseDir = path.dirname(path.resolve(resultFile));
  const relativeCaseDir = path.relative(casesRoot, caseDir);
  if (!relativeCaseDir
      || relativeCaseDir.includes(path.sep)
      || relativeCaseDir === '.'
      || relativeCaseDir === '..'
      || path.isAbsolute(relativeCaseDir)
      || !/^[\p{Letter}\p{Number}_-]+$/u.test(relativeCaseDir)) {
    return '';
  }
  assertNoSymlinkPathSegments(workspace, caseDir);
  return caseDir;
}

function defaultOutDir(args, finalResult, resultFiles = []) {
  if (args.script) {
    const caseDir = canonicalCaseDirFromScript(args.script);
    if (caseDir) return caseDir;
  }
  const canonicalResultCaseDir = canonicalCaseDirFromResult(resultFiles[resultFiles.length - 1]);
  if (!args.script && canonicalResultCaseDir) return canonicalResultCaseDir;
  const caseId = args.script
    ? path.basename(args.script, path.extname(args.script))
    : safeFilePart(finalResult.case || 'unknown-script');
  return path.join(process.cwd(), 'worktree', 'cases', safeFilePart(caseId));
}

function resolveSingleCaseDir(args, finalResult, resultFiles = []) {
  const canonicalCaseDirs = new Set();
  if (args.script) {
    const scriptCaseDir = canonicalCaseDirFromScript(args.script);
    if (scriptCaseDir) canonicalCaseDirs.add(scriptCaseDir);
  }
  for (const resultFile of resultFiles) {
    const resultCaseDir = canonicalCaseDirFromResult(resultFile);
    if (resultCaseDir) canonicalCaseDirs.add(resultCaseDir);
  }
  if (canonicalCaseDirs.size > 1) {
    throw new Error('Report inputs must resolve to one canonical Case directory');
  }
  return canonicalCaseDirs.size
    ? [...canonicalCaseDirs][0]
    : path.resolve(defaultOutDir(args, finalResult, resultFiles));
}

function assertExplicitOutDir(outDir, canonicalCaseDir) {
  if (!outDir) return;
  if (path.resolve(outDir) !== canonicalCaseDir) {
    throw new Error(`--out-dir must equal the canonical Case directory: ${canonicalCaseDir}`);
  }
}

function canonicalManifestResult(resultFile) {
  const workspace = fs.realpathSync(process.cwd());
  const filePath = path.resolve(resultFile);
  const casesRoot = path.join(workspace, 'worktree', 'cases');
  const relativeFile = path.relative(casesRoot, filePath);
  const segments = relativeFile.split(path.sep);
  const caseId = segments[0];
  const caseDir = path.join(casesRoot, caseId || '');
  const relativeCaseFile = path.relative(caseDir, filePath);
  const isCanonicalResult = relativeCaseFile === 'result.json';
  const isArtifactEvidence = relativeCaseFile.startsWith(`artifacts${path.sep}`)
    && path.extname(filePath).toLowerCase() === '.json';
  if (!caseId
      || !/^[\p{Letter}\p{Number}_-]+$/u.test(caseId)
      || relativeFile === '..'
      || relativeFile.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativeFile)
      || (!isCanonicalResult && !isArtifactEvidence)) {
    throw new Error(`Manifest result must be the canonical result.json or JSON evidence under the same Case artifacts directory: ${filePath}`);
  }
  assertNoSymlinkPathSegments(workspace, filePath);
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || fs.realpathSync(filePath) !== filePath) {
    throw new Error(`Manifest result must be a regular non-symlink file: ${filePath}`);
  }
  return { caseDir, isCanonicalResult };
}

function canonicalManifestFailureAnalysis(file, caseDir) {
  if (!file) return;
  const workspace = fs.realpathSync(process.cwd());
  const filePath = path.resolve(file);
  const artifactsRoot = path.join(caseDir, 'artifacts');
  const relativeFile = path.relative(artifactsRoot, filePath);
  if (!relativeFile
      || relativeFile === '..'
      || relativeFile.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativeFile)
      || path.extname(filePath).toLowerCase() !== '.json') {
    throw new Error(`Manifest failureAnalysis must be JSON evidence under the same Case artifacts directory: ${filePath}`);
  }
  assertNoSymlinkPathSegments(workspace, filePath);
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || fs.realpathSync(filePath) !== filePath) {
    throw new Error(`Manifest failureAnalysis must be a regular non-symlink file: ${filePath}`);
  }
}

function canonicalManifestScript(file, caseDir) {
  if (!file) return;
  const workspace = fs.realpathSync(process.cwd());
  const filePath = path.resolve(file);
  const expected = path.join(caseDir, 'script.js');
  if (filePath !== expected) {
    throw new Error(`Manifest script must be the canonical script.js in the same Case: ${filePath}`);
  }
  assertNoSymlinkPathSegments(workspace, filePath);
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    throw new Error(`Manifest script must be an existing regular non-symlink file: ${filePath} (${error.message})`);
  }
  if (stat.isSymbolicLink() || !stat.isFile() || fs.realpathSync(filePath) !== filePath) {
    throw new Error(`Manifest script must be a regular non-symlink file: ${filePath}`);
  }
}

function aggregateCaseDir(runs) {
  const validatedRuns = runs.map((run) => {
    const results = run.resultFiles.map(canonicalManifestResult);
    if (!results[results.length - 1].isCanonicalResult) {
      throw new Error(`Manifest run ${run.name} final result must be the canonical Case result.json`);
    }
    return { run, results };
  });
  const manifestResults = validatedRuns.flatMap((entry) => entry.results);
  const caseDirs = new Set(manifestResults.map((result) => result.caseDir));
  if (caseDirs.size !== 1) {
    throw new Error('Aggregate manifest results must resolve to one canonical Case directory; cross-Case manifests are not supported');
  }
  if (!manifestResults.some((result) => result.isCanonicalResult)) {
    throw new Error('Aggregate manifest must include the canonical Case result.json');
  }
  const caseDir = [...caseDirs][0];
  for (const { run } of validatedRuns) {
    canonicalManifestScript(run.script, caseDir);
    canonicalManifestFailureAnalysis(run.failureAnalysisFile, caseDir);
  }
  return caseDir;
}

function canonicalCaseDirFromScript(script) {
  const scriptFile = path.resolve(script);
  if (path.basename(scriptFile) !== 'script.js') return '';
  const workspace = fs.realpathSync(process.cwd());
  const casesRoot = path.join(workspace, 'worktree', 'cases');
  const caseDir = path.dirname(scriptFile);
  const caseId = path.basename(caseDir);
  if (!/^[\p{Letter}\p{Number}_-]+$/u.test(caseId)) return '';
  if (caseDir !== path.join(casesRoot, caseId)) return '';
  assertNoSymlinkPathSegments(workspace, caseDir);
  try {
    if (fs.realpathSync(scriptFile) !== scriptFile) return '';
  } catch {
    return '';
  }
  return caseDir;
}

function lexicalCanonicalCaseFile(file, expectedName, requireSafeCaseId) {
  if (!file) return null;
  const workspace = fs.realpathSync(process.cwd());
  const filePath = path.resolve(file);
  if (path.basename(filePath) !== expectedName) return null;
  const casesRoot = path.join(workspace, 'worktree', 'cases');
  const caseDir = path.dirname(filePath);
  const relativeCaseDir = path.relative(casesRoot, caseDir);
  if (!relativeCaseDir
      || relativeCaseDir.includes(path.sep)
      || relativeCaseDir === '.'
      || relativeCaseDir === '..'
      || path.isAbsolute(relativeCaseDir)
      || (requireSafeCaseId && !/^[\p{Letter}\p{Number}_-]+$/u.test(relativeCaseDir))) {
    return null;
  }
  return { workspace, filePath, caseDir };
}

function assertCanonicalCaseInputFile(file, expectedName, requireSafeCaseId) {
  const canonical = lexicalCanonicalCaseFile(file, expectedName, requireSafeCaseId);
  if (!canonical) return;
  assertNoSymlinkPathSegments(canonical.workspace, canonical.caseDir);
  let stat;
  try {
    stat = fs.lstatSync(canonical.filePath);
  } catch (error) {
    throw new Error(`Canonical ${expectedName} must be an existing regular file: ${canonical.filePath} (${error.message})`);
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`Canonical ${expectedName} must not be a symbolic link: ${canonical.filePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`Canonical ${expectedName} must be a regular file: ${canonical.filePath}`);
  }
  if (fs.realpathSync(canonical.filePath) !== canonical.filePath) {
    throw new Error(`Canonical ${expectedName} realpath differs from its lexical path: ${canonical.filePath}`);
  }
}

function assertNoSymlinkPathSegments(workspace, target) {
  const workspaceReal = fs.realpathSync(workspace);
  const targetPath = path.resolve(target);
  const relative = path.relative(workspaceReal, targetPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Default report path escapes workspace: ${targetPath}`);
  }
  let current = workspaceReal;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Default report path contains a symbolic link: ${current}`);
    }
  }
}

function isInsideOrEqual(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function ensureDefaultOutDir(outDir, scope) {
  const workspace = fs.realpathSync(process.cwd());
  const allowedRoot = scope === 'cases'
    ? path.join(workspace, 'worktree', 'cases')
    : path.join(workspace, 'worktree');
  const target = path.resolve(outDir);
  if (!isInsideOrEqual(allowedRoot, target) || (scope === 'cases' && target === allowedRoot)) {
    throw new Error(`Default report path is outside the canonical ${scope} directory: ${target}`);
  }
  assertNoSymlinkPathSegments(workspace, target);
  ensureDir(target);
  assertNoSymlinkPathSegments(workspace, target);
  const realAllowedRoot = fs.realpathSync(allowedRoot);
  const realTarget = fs.realpathSync(target);
  if (!isInsideOrEqual(realAllowedRoot, realTarget) || (scope === 'cases' && realTarget === realAllowedRoot)) {
    throw new Error(`Default report path resolves outside the canonical ${scope} directory: ${target}`);
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
