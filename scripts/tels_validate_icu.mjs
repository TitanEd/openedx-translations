#!/usr/bin/env node
/*
 * Check the react-intl (ICU MessageFormat) translations of the TitanEd languages.
 *
 *   node scripts/tels_validate_icu.mjs <mfe directory with node_modules> [--langs ar,hi,es_419]
 *                                      [--json report.json] [resource ...]
 *
 * A translation whose ICU syntax is broken, or whose arguments differ from the English source, is
 * dropped by react-intl at run time: the page shows the English text although a "translation"
 * exists. Machine translation produces exactly that, by translating what is inside the braces:
 *
 *   source  "Upload {count, plural, one {{firstPart} files} other {…}}"
 *   broken  "अपलोड करें {गिनती, बहुवचन, एक {{firstPart} फ़ाइलें} अन्य {…}}"
 *
 * For every resource (default: every `translations/<name>/src/i18n` folder that has a
 * `transifex_input.json`) and language the script reports the messages that
 *   - do not parse,
 *   - use an argument the source does not have, or miss one of the source's arguments,
 *   - changed the kind of an argument (plural, select, number, date…) or the keys of a select,
 *   - lost the `other` branch of a plural or select.
 *
 * The parser is the one react-intl uses, taken from the node_modules of the MFE given as first
 * argument (any TitanEd MFE fork after "npm ci").
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
if (!args.length) {
  console.error('usage: tels_validate_icu.mjs <mfe directory> [--langs ar,hi,es_419] [--json out.json] [resource ...]');
  process.exit(2);
}
const mfeDir = path.resolve(args[0]);
const flag = (name, fallback) => { const i = args.indexOf(name); return i > 0 ? args[i + 1] : fallback; };
const langs = flag('--langs', 'ar,hi,es_419').split(',');
const jsonOut = flag('--json');
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const named = args.slice(1).filter((a, i, all) => !a.startsWith('--') && !['--langs', '--json'].includes(all[i - 1]));

const require = createRequire(path.join(mfeDir, 'package.json'));
const { parse, TYPE } = require('@formatjs/icu-messageformat-parser');

// name -> { kind, keys } for every argument of a message, nested ones included.
function describe(ast, out = {}) {
  for (const node of ast) {
    if (node.type === TYPE.literal || node.type === TYPE.pound) continue;
    if (node.type === TYPE.tag) { out[`<${node.value}>`] = { kind: 'tag' }; describe(node.children, out); continue; }
    const kind = { [TYPE.argument]: 'argument', [TYPE.number]: 'number', [TYPE.date]: 'date', [TYPE.time]: 'time', [TYPE.select]: 'select', [TYPE.plural]: 'plural' }[node.type];
    const entry = out[node.value] || (out[node.value] = { kind, keys: new Set() });
    if (node.type === TYPE.select || node.type === TYPE.plural) {
      entry.kind = kind;
      for (const [key, option] of Object.entries(node.options)) { entry.keys.add(key); describe(option.value, out); }
    }
  }
  return out;
}

function problems(source, translation) {
  let src; let dst;
  try { src = describe(parse(source)); } catch (e) { return []; } // a broken source is not ours to fix
  try { dst = describe(parse(translation)); } catch (e) { return [`does not parse: ${e.message}`]; }
  const found = [];
  for (const name of Object.keys(src)) if (!(name in dst)) found.push(`missing ${name}`);
  for (const name of Object.keys(dst)) if (!(name in src)) found.push(`unknown ${name}`);
  for (const [name, a] of Object.entries(src)) {
    const b = dst[name]; if (!b) continue;
    const complex = (k) => k === 'plural' || k === 'select';
    if (complex(a.kind) !== complex(b.kind) || (complex(a.kind) && a.kind !== b.kind)) found.push(`${name}: ${a.kind} became ${b.kind}`);
    if (b.kind === 'plural' || b.kind === 'select') {
      if (!b.keys.has('other')) found.push(`${name}: no "other" branch`);
      if (a.kind === 'select' && b.kind === 'select') {
        const lost = [...a.keys].filter((k) => !b.keys.has(k)); const extra = [...b.keys].filter((k) => !a.keys.has(k));
        if (lost.length || extra.length) found.push(`${name}: select keys changed (${[...lost.map((k) => `-${k}`), ...extra.map((k) => `+${k}`)].join(' ')})`);
      }
    }
  }
  return found;
}

const resources = named.length ? named : fs.readdirSync(path.join(repo, 'translations'))
  .filter((name) => fs.existsSync(path.join(repo, 'translations', name, 'src/i18n/transifex_input.json')));
const report = {};
let total = 0;
for (const resource of resources) {
  const dir = path.join(repo, 'translations', resource.replace(/^translations\//, '').replace(/\/src\/i18n.*$/, ''), 'src/i18n');
  const sourceFile = path.join(dir, 'transifex_input.json');
  if (!fs.existsSync(sourceFile)) { console.error(`skip ${resource}: no transifex_input.json`); continue; }
  const source = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
  const text = (value) => (value && typeof value === 'object' ? value.defaultMessage || value.string || '' : value);
  for (const lang of langs) {
    const file = path.join(dir, 'messages', `${lang}.json`);
    if (!fs.existsSync(file)) continue;
    const messages = JSON.parse(fs.readFileSync(file, 'utf8'));
    const bad = {};
    for (const [id, translation] of Object.entries(messages)) {
      if (!(id in source) || typeof translation !== 'string') continue;
      const found = problems(text(source[id]), translation);
      if (found.length) bad[id] = { problems: found, source: text(source[id]), translation };
    }
    const count = Object.keys(bad).length;
    if (count) { report[`${path.basename(path.dirname(path.dirname(dir)))}:${lang}`] = bad; total += count; }
  }
}
for (const [key, bad] of Object.entries(report)) console.log(`${key.padEnd(52)} ${String(Object.keys(bad).length).padStart(4)} broken`);
console.log(`${total} broken translation(s) in ${resources.length} resource(s)`);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(report, null, 1));
process.exit(total ? 1 : 0);
