#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_DOCUMENT_FILES = ['SKILL.md', 'references/handoff-contract.md', 'agents/openai.yaml'];
const RULES = [
  {
    id: 'case-specific-data-strategy',
    pattern: /(?:递增|轮换|更换|替换|随机生成).{0,16}(?:手机号|手机号码|邮箱|身份证号|账号)|(?:phone|mobile|email|account).{0,24}(?:increment|rotate|replace|random)/i,
    message: 'Public guidance must not prescribe a Case-specific runtime-data workaround.',
  },
  {
    id: 'concrete-personal-identifier',
    pattern: /(?<!\d)1[3-9]\d{9}(?!\d)|\b\d{17}[0-9Xx]\b/,
    message: 'Public guidance must not contain a concrete phone number or identity number.',
  },
];
const NEUTRAL_FIXTURE_PREFIX = /^(?:example|sample|resource)-/;
const STRUCTURED_FIXTURE_PATTERN = /"(?:role|routeId|scopeRef)"\s*:\s*"([^"]+)"/g;

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--help') args.help = true;
    else if (key === '--skill') args.skill = argv[++index];
    else throw new Error(`Unexpected argument: ${key}`);
  }
  return args;
}

function usage() {
  return 'Usage: node validate_skill_content.js --skill <skill-directory>';
}

function filesToCheck(root, report) {
  const files = [];
  for (const relativePath of REQUIRED_DOCUMENT_FILES) {
    const filePath = path.join(root, relativePath);
    if (!fs.existsSync(filePath)) {
      report.errors.push({ file: filePath, line: 0, rule: 'required-document', message: 'Required document is missing.' });
    } else files.push(filePath);
  }

  const scriptsDirectory = path.join(root, 'scripts');
  if (fs.existsSync(scriptsDirectory)) {
    for (const entry of fs.readdirSync(scriptsDirectory, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.test.js') && entry.name !== 'validate_skill_content.test.js') {
        files.push(path.join(scriptsDirectory, entry.name));
      }
    }
  }
  const referencesDirectory = path.join(root, 'references');
  if (fs.existsSync(referencesDirectory)) {
    const visit = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const filePath = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(filePath);
        else if (entry.isFile()) files.push(filePath);
      }
    };
    visit(referencesDirectory);
  }
  return [...new Set(files)].sort();
}

function lineNumber(content, position) {
  return content.slice(0, Math.max(0, position)).split(/\r?\n/).length;
}

function validateSkillContent(skillDirectory) {
  const root = path.resolve(skillDirectory);
  const report = { status: 'passed', skillDirectory: root, checkedFiles: [], errors: [] };

  for (const filePath of filesToCheck(root, report)) {
    report.checkedFiles.push(filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    const normalizedContent = content.replace(/\s+/g, ' ');
    const lines = content.split(/\r?\n/);
    for (const rule of RULES) {
      if (rule.id === 'concrete-personal-identifier' && filePath.endsWith('.test.js')) continue;
      if (rule.pattern.test(normalizedContent)) {
        report.errors.push({ file: filePath, line: 1, rule: rule.id, message: rule.message });
      }
    }
    for (const match of content.matchAll(STRUCTURED_FIXTURE_PATTERN)) {
      if (!NEUTRAL_FIXTURE_PREFIX.test(match[1])) {
        report.errors.push({
          file: filePath,
          line: lineNumber(content, match.index),
          rule: 'non-neutral-structured-fixture',
          message: 'Public Skill references must use neutral role, route, and scope fixture values.',
        });
      }
    }
    for (const [index, line] of lines.entries()) {
      if (filePath.endsWith('.test.js')) {
        for (const match of line.matchAll(/frontend-component:([A-Za-z0-9._-]+)/g)) {
          if (!NEUTRAL_FIXTURE_PREFIX.test(match[1])) {
            report.errors.push({
              file: filePath,
              line: index + 1,
              rule: 'non-neutral-component-fixture',
              message: 'Public Skill tests must use an example-, sample-, or resource-prefixed component fixture.',
            });
          }
        }
      }
    }
  }

  if (report.errors.length > 0) report.status = 'failed';
  return report;
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    if (!args.skill) throw new Error(`Missing --skill.\n${usage()}`);
    const report = validateSkillContent(args.skill);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.status !== 'passed') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = { validateSkillContent };

if (require.main === module) main();
