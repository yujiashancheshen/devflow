#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function cleanListItem(line) {
  return String(line || '')
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, '')
    .trim();
}

function parseCaseBody(body) {
  const result = {
    requirement: '',
    preconditions: [],
    steps: [],
    expectedResults: [],
  };
  let section = '';
  for (const rawLine of String(body || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const requirement = line.match(/^\*\*覆盖需求\*\*\s*[：:]\s*(.+)$/);
    if (requirement) {
      result.requirement = requirement[1].trim();
      section = '';
      continue;
    }
    const sectionHeading = line.match(/^\*\*(前置条件|步骤|预期结果)\*\*\s*$/);
    if (sectionHeading) {
      section = sectionHeading[1];
      continue;
    }
    if (/^#{1,6}\s+/.test(line) || /^---+$/.test(line)) {
      section = '';
      continue;
    }
    const item = cleanListItem(line);
    if (!item || item === line && !section) continue;
    if (section === '前置条件') result.preconditions.push(item);
    else if (section === '步骤') result.steps.push(item);
    else if (section === '预期结果') result.expectedResults.push(item);
  }
  return result;
}

function extractMarkdownCases(markdown, options = {}) {
  const prefix = options.prefix || 'F0';
  const headingPattern = new RegExp(`^####\\s+(${escapeRegExp(prefix)}-\\d+)\\s+(.+?)\\s*$`, 'gmu');
  const matches = [...String(markdown || '').matchAll(headingPattern)];
  return matches.map((match, index) => {
    const bodyStart = match.index + match[0].length;
    const bodyEnd = index + 1 < matches.length ? matches[index + 1].index : String(markdown).length;
    return {
      caseId: match[1],
      title: match[2].trim(),
      ...parseCaseBody(String(markdown).slice(bodyStart, bodyEnd)),
    };
  });
}

function parseArgs(argv) {
  const args = { input: '', prefix: 'F0', json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input') args.input = argv[++index];
    else if (arg === '--prefix') args.prefix = argv[++index];
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  return `Usage:
  node extract_markdown_cases.js --input <prd-or-case.md> [--prefix F0] [--json]

Extracts level-4 numbered Case sections such as "#### F0-01 Case title".
`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  if (!args.input) throw new Error('--input is required');
  const source = path.resolve(args.input);
  const cases = extractMarkdownCases(fs.readFileSync(source, 'utf8'), { prefix: args.prefix });
  const output = {
    schemaVersion: 1,
    source,
    prefix: args.prefix,
    count: cases.length,
    caseIds: cases.map((item) => item.caseId),
    cases,
  };
  if (args.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  else process.stdout.write(cases.map((item) => `${item.caseId}\t${item.title}`).join('\n') + (cases.length ? '\n' : ''));
}

module.exports = { extractMarkdownCases, parseCaseBody };

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
