#!/usr/bin/env node
/*
 * Audit how completely a TitanEd MFE fork can be translated.
 *
 *   node scripts/tels_audit_mfe.mjs <mfe directory> [--json report.json] [--langs ar,hi,es_419]
 *                                   [--src src] [--resource translations/<dir>]...
 *
 * It reads the MFE's source with the MFE's own @babel/parser (run "npm ci" there first) and reports:
 *
 *   1. messages   every react-intl message ({ id, defaultMessage } objects and <FormattedMessage>), and
 *                 for each language the ids that have no translation in this repository, or whose
 *                 "translation" is the English text. The resources searched are the
 *                 `translations/<dir>:<name>` mappings of the MFE's `make pull_translations` target
 *                 (override or extend with --resource).
 *   2. literals   text written straight into the code, which no translation file can ever reach:
 *                 JSX text, string-valued attributes that people read (placeholder, title, alt,
 *                 aria-label, label…), strings in `{cond ? 'A' : 'B'}` and in object properties such as
 *                 `label: 'Dashboard'`.
 *
 * The literal search is a heuristic: read the list, wrap what is user-facing in a message, ignore the
 * rest (class names, test ids and data keys are filtered out, a few technical strings remain).
 *
 * Exit code 0 always; this is a report, not a gate.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
if (!args.length || args[0].startsWith('--')) {
  console.error('usage: tels_audit_mfe.mjs <mfe directory> [--json out.json] [--langs ar,hi,es_419] [--src src] [--resource translations/<dir>]');
  process.exit(2);
}
const mfeDir = path.resolve(args[0]);
const option = (name, fallback) => { const i = args.indexOf(name); return i > 0 ? args[i + 1] : fallback; };
const options = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const langs = option('--langs', 'ar,hi,es_419').split(',');
const srcDir = path.join(mfeDir, option('--src', 'src'));
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const require = createRequire(path.join(mfeDir, 'package.json'));
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const SKIP_DIR = /(^|\/)(node_modules|__snapshots__|__mocks__|__tests__|i18n|dist|coverage|testUtils|test-utils|setupTest)(\/|$)/;
const SKIP_FILE = /(\.test\.|\.spec\.|\.stories\.|\.d\.ts$|factories|fixtures|mock|\.messages\.|(^|\/)messages\.(js|ts)x?$)/i;
const READ_ATTRS = new Set(['placeholder', 'title', 'alt', 'aria-label', 'label', 'tooltip', 'helperText', 'helpText',
  'header', 'heading', 'subHeader', 'description', 'text', 'message', 'floatingLabel', 'screenReaderText',
  'confirmLabel', 'cancelLabel', 'closeLabel', 'buttonText', 'emptyText', 'tooltipContent', 'aria-description']);
const READ_PROPS = new Set(['label', 'title', 'text', 'placeholder', 'message', 'tooltip', 'description', 'heading',
  'header', 'buttonText', 'helpText', 'subtitle', 'displayName', 'ariaLabel', 'alt', 'name']);
const WORD = /\p{L}{2,}/u;
// Not prose: identifiers, paths, URLs, CSS, colors, MIME types, format patterns…
const TECHNICAL = /^(?:[a-z0-9]+(?:[-_.:/][A-Za-z0-9]+)+|[a-z][a-zA-Z0-9]*|[A-Z0-9_]+|#[0-9a-fA-F]{3,8}|https?:.*|\.{0,2}\/.*|[\w.-]+@[\w.-]+|[a-z]+\/[a-z0-9.+-]+|\d.*)$/;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    const rel = path.relative(mfeDir, file);
    if (entry.isDirectory()) { if (!SKIP_DIR.test(rel)) walk(file, out); } else if (/\.(jsx?|tsx?)$/.test(entry.name)) out.push(file);
  }
  return out;
}

function staticString(node) {
  if (!node) return null;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis.map((q) => q.value.cooked).join('');
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = staticString(node.left); const right = staticString(node.right);
    return left !== null && right !== null ? left + right : null;
  }
  return null;
}

const prose = (text, strict) => {
  const value = (text || '').replace(/\s+/g, ' ').trim();
  if (!value || !WORD.test(value)) return null;
  if (strict && (TECHNICAL.test(value) && !/^[A-Z][a-z]+$/.test(value))) return null;
  return value;
};

const messages = {}; // id -> { text, file }
const literals = []; // { file, line, kind, text }
const failed = [];

for (const file of walk(srcDir)) {
  const rel = path.relative(mfeDir, file);
  const isMessagesFile = SKIP_FILE.test(rel);
  let ast;
  try {
    ast = parser.parse(fs.readFileSync(file, 'utf8'), {
      sourceType: 'module',
      errorRecovery: true,
      plugins: ['jsx', /\.tsx?$/.test(file) ? 'typescript' : 'flow', 'classProperties', 'decorators-legacy', 'optionalChaining', 'nullishCoalescingOperator', 'exportDefaultFrom', 'dynamicImport'],
    });
  } catch (error) { failed.push(`${rel}: ${error.message}`); continue; }
  const messageNodes = new WeakSet();
  const add = (node, kind, text, strict = true) => {
    if (isMessagesFile || /(\.test\.|\.spec\.)/.test(rel)) return;
    const value = prose(text, strict);
    if (value) literals.push({ file: rel, line: node.loc ? node.loc.start.line : 0, kind, text: value });
  };
  traverse(ast, {
    ObjectExpression(p) {
      const props = Object.fromEntries(p.node.properties.filter((x) => x.type === 'ObjectProperty' && !x.computed)
        .map((x) => [x.key.name || x.key.value, x.value]));
      const id = staticString(props.id); const text = staticString(props.defaultMessage);
      if (id !== null && props.defaultMessage) {
        messageNodes.add(p.node);
        if (text !== null && !(id in messages)) messages[id] = { text, file: rel };
      }
    },
    JSXOpeningElement(p) {
      if (p.node.name.name !== 'FormattedMessage') return;
      const attr = (name) => { const a = p.node.attributes.find((x) => x.type === 'JSXAttribute' && x.name.name === name); return a && (a.value.type === 'JSXExpressionContainer' ? staticString(a.value.expression) : staticString(a.value)); };
      const id = attr('id'); const text = attr('defaultMessage');
      if (id && text !== null && text !== undefined && !(id in messages)) messages[id] = { text, file: rel };
    },
    JSXText(p) { add(p.node, 'jsx text', p.node.value, false); },
    JSXAttribute(p) {
      const name = p.node.name.name;
      if (!READ_ATTRS.has(name) || !p.node.value) return;
      if (p.parent.name && p.parent.name.name === 'FormattedMessage') return;
      const value = p.node.value.type === 'JSXExpressionContainer' ? p.node.value.expression : p.node.value;
      const text = staticString(value);
      if (text !== null) add(p.node, `attribute ${name}`, text);
      else if (value.type === 'ConditionalExpression') [value.consequent, value.alternate].forEach((b) => { const t = staticString(b); if (t !== null) add(b, `attribute ${name}`, t); });
    },
    JSXExpressionContainer(p) {
      if (p.parent.type === 'JSXAttribute') return;
      const e = p.node.expression;
      const direct = staticString(e);
      if (direct !== null) { add(p.node, 'jsx expression', direct, false); return; }
      const branches = e.type === 'ConditionalExpression' ? [e.consequent, e.alternate] : e.type === 'LogicalExpression' ? [e.right] : [];
      branches.forEach((b) => { const t = staticString(b); if (t !== null) add(b, 'jsx expression', t); });
    },
    ObjectProperty(p) {
      if (p.node.computed || messageNodes.has(p.parent)) return;
      const key = p.node.key.name || p.node.key.value;
      if (!READ_PROPS.has(key)) return;
      const parentProps = p.parent.properties.map((x) => (x.key ? x.key.name || x.key.value : ''));
      if (parentProps.includes('defaultMessage')) return;
      const text = staticString(p.node.value);
      // Object values are noisier than JSX: keep what looks like words for people.
      if (text !== null && (/\s/.test(text.trim()) || /^[A-Z][a-z]{2,}$/.test(text.trim()))) add(p.node, `property ${key}`, text);
    },
    AssignmentExpression(p) {
      const left = p.node.left;
      if (left.type === 'MemberExpression' && left.property.name === 'title' && left.object.name === 'document') {
        const text = staticString(p.node.right); if (text !== null) add(p.node, 'document.title', text, false);
      }
    },
  });
}

// --- translations in this repository -------------------------------------------------------------------
let resources = options('--resource');
const makefile = path.join(mfeDir, 'Makefile');
if (fs.existsSync(makefile)) {
  const block = (fs.readFileSync(makefile, 'utf8').match(/^pull_translations:[\s\S]*?\n\n/m) || [''])[0];
  resources = resources.concat([...block.matchAll(/(translations\/[^\s:]+):[\w-]+/g)].map((m) => m[1]));
}
resources = [...new Set(resources)];
const report = { mfe: path.basename(mfeDir), files: 0, messages: Object.keys(messages).length, resources, missing: {}, sameAsEnglish: {}, literals };
for (const lang of langs) {
  const known = {};
  for (const resource of resources) {
    const file = path.join(repo, resource, `${lang}.json`);
    if (fs.existsSync(file)) Object.assign(known, JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  report.missing[lang] = Object.keys(messages).filter((id) => !known[id]);
  report.sameAsEnglish[lang] = Object.keys(messages).filter((id) => known[id] && known[id] === messages[id].text
    && /\p{L}{4,}/u.test(messages[id].text.replace(/\{[^}]*\}/g, '')));
}
report.source = Object.fromEntries(Object.entries(messages).map(([id, m]) => [id, m.text]));
report.sourceFiles = Object.fromEntries(Object.entries(messages).map(([id, m]) => [id, m.file]));

const out = option('--json');
if (out) fs.writeFileSync(out, JSON.stringify(report, null, 1));
console.log(`${report.mfe}: ${report.messages} messages, resources: ${resources.map((r) => r.split('/')[1]).join(', ') || 'none'}`);
for (const lang of langs) console.log(`  ${lang.padEnd(7)} missing ${String(report.missing[lang].length).padStart(4)}   same as English ${String(report.sameAsEnglish[lang].length).padStart(4)}`);
console.log(`  hard-coded text candidates: ${literals.length}`);
if (failed.length) console.log(`  could not parse: ${failed.length}\n    ${failed.slice(0, 5).join('\n    ')}`);
