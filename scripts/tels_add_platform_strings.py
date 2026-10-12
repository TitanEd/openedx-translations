#!/usr/bin/env python3
"""
Add edx-platform source strings that the upstream extraction leaves out.

Since the Mako extraction step was dropped from edx-platform's ``make extract_translations``,
``translations/edx-platform/conf/locale/en/LC_MESSAGES/django.po`` no longer lists the strings
of the platform's Mako templates (problem, video and sequence chrome inside units, wiki,
progress page, course tabs, Studio legacy screens, e-mails...) and a few Python strings added
after the last upstream extraction. A string that is not in the catalog can never be translated,
so those pages stay English whatever the language.

This script appends the missing strings to the English source and to each TitanEd language.
Existing entries are never rewritten: new entries are appended at the end of each file, below a
marker comment, so the diff against upstream stays small and merges stay simple.

Extract the platform strings first (inside the LMS container, nothing is written to the
platform checkout)::

    cd /openedx/edx-platform
    echo '[python: **.py]' > /tmp/py.cfg
    pybabel extract -F /tmp/py.cfg -o /tmp/py.pot lms cms common openedx xmodule
    pybabel extract -F conf/locale/babel_mako.cfg -o /tmp/mako.pot .

(with the usual ``-k`` keywords and ``--ignore-dirs`` for node_modules, migrations and tests),
then::

    # 1. add the strings; translations are looked up in older catalogs when given
    python scripts/tels_add_platform_strings.py add /tmp/py.pot /tmp/mako.pot \
        [--memory "old-catalogs/*_{lang}.po"]

    # 2. list what still needs a translation (JSON: {msgid: ""} or {msgid: [plural forms]})
    python scripts/tels_add_platform_strings.py todo hi > todo_hi.json

    # 3. write the translations back
    python scripts/tels_add_platform_strings.py fill hi todo_hi.json

    # 4. check placeholders of every TitanEd entry
    python scripts/tels_add_platform_strings.py check

``--domain djangojs`` does the same for the JavaScript catalog.
"""

import argparse
import glob
import json
import re
import sys
from pathlib import Path

import polib

ROOT = Path(__file__).resolve().parents[1] / "translations" / "edx-platform" / "conf" / "locale"
LANGUAGES = ("ar", "hi", "es_419")
NPLURALS = {"ar": 6, "hi": 2, "es_419": 3}
MARKER = "# ---- TitanEd: platform strings missing from the upstream extraction ----"
PLACEHOLDER = re.compile(r"%\([A-Za-z0-9_]+\)[sdif]|%[sdif]|\{[A-Za-z0-9_.]*\}|\$\{[^}]*\}|</?[a-zA-Z][^>]*>")


def po_path(lang, domain):
    return ROOT / lang / "LC_MESSAGES" / f"{domain}.po"


def placeholders(text):
    return sorted(PLACEHOLDER.findall(text))


def same_placeholders(source, translation):
    return placeholders(source) == placeholders(translation)


def load_memory(pattern, lang):
    memory = {}
    if not pattern:
        return memory
    for name in sorted(glob.glob(pattern.format(lang=lang))):
        for entry in polib.pofile(name):
            if entry.translated() and not entry.fuzzy:
                memory[(entry.msgctxt, entry.msgid)] = entry
    return memory


def new_entry(source, lang, memory):
    entry = polib.POEntry(
        msgid=source.msgid,
        msgctxt=source.msgctxt,
        occurrences=[(path, "") for path, _ in source.occurrences][:3],
        flags=[flag for flag in source.flags if flag != "fuzzy"],
        comment=source.comment,
    )
    known = memory.get((source.msgctxt, source.msgid)) if lang != "en" else None
    if source.msgid_plural:
        entry.msgid_plural = source.msgid_plural
        count = 2 if lang == "en" else NPLURALS[lang]
        entry.msgstr_plural = {index: "" for index in range(count)}
        if known is not None and len(known.msgstr_plural) == count:
            if all(same_placeholders(source.msgid_plural, text) or same_placeholders(source.msgid, text)
                   for text in known.msgstr_plural.values()):
                entry.msgstr_plural = dict(known.msgstr_plural)
    elif known is not None and same_placeholders(source.msgid, known.msgstr):
        entry.msgstr = known.msgstr
    return entry


def append_entries(path, entries):
    text = path.read_text(encoding="utf-8")
    if not text.endswith("\n"):
        text += "\n"
    if MARKER not in text:
        text += "\n" + MARKER + "\n"
    text += "".join("\n" + str(entry) for entry in entries)
    path.write_text(text if text.endswith("\n") else text + "\n", encoding="utf-8")


def titaned_entries(path):
    """Entries below the marker (the ones this script owns)."""
    text = path.read_text(encoding="utf-8")
    if MARKER not in text:
        return polib.pofile(path), set()
    catalog = polib.pofile(path)
    owned_text = text.split(MARKER, 1)[1]
    owned = {(entry.msgctxt, entry.msgid) for entry in polib.pofile(owned_text)}
    return catalog, owned


def command_add(args):
    sources = {}
    for name in args.pot:
        for entry in polib.pofile(name):
            if entry.msgid and not entry.obsolete:
                sources.setdefault((entry.msgctxt, entry.msgid), entry)
    for lang in ("en",) + LANGUAGES:
        path = po_path(lang, args.domain)
        have = {(entry.msgctxt, entry.msgid) for entry in polib.pofile(path)}
        memory = load_memory(args.memory, lang)
        entries = [new_entry(source, lang, memory) for key, source in sorted(sources.items(), key=lambda i: i[0][1])
                   if key not in have]
        if entries:
            append_entries(path, entries)
        translated = sum(1 for entry in entries if entry.translated())
        print(f"{lang:7} added {len(entries):5}  translated from memory {translated:5}")


def command_todo(args):
    catalog, owned = titaned_entries(po_path(args.lang, args.domain))
    todo = {}
    for entry in catalog:
        if (entry.msgctxt, entry.msgid) in owned and not entry.translated():
            todo[entry.msgid] = [entry.msgid_plural] if entry.msgid_plural else ""
    json.dump(todo, sys.stdout, ensure_ascii=False, indent=0)
    print(f"{args.lang}: {len(todo)} to translate", file=sys.stderr)


def command_fill(args):
    path = po_path(args.lang, args.domain)
    translations = json.loads(Path(args.json).read_text(encoding="utf-8"))
    catalog, owned = titaned_entries(path)
    text = path.read_text(encoding="utf-8")
    head, tail = text.split(MARKER, 1)
    tail_catalog = polib.pofile(tail)
    done = problems = 0
    for entry in tail_catalog:
        value = translations.get(entry.msgid)
        if not value:
            continue
        if entry.msgid_plural:
            if not isinstance(value, list) or len(value) != NPLURALS[args.lang]:
                print(f"plural forms needed ({NPLURALS[args.lang]}): {entry.msgid!r}", file=sys.stderr)
                problems += 1
                continue
            entry.msgstr_plural = dict(enumerate(value))
        else:
            if not same_placeholders(entry.msgid, value):
                print(f"placeholders differ: {entry.msgid!r} -> {value!r}", file=sys.stderr)
                problems += 1
                continue
            entry.msgstr = value
        done += 1
    path.write_text(head + MARKER + "\n" + "".join("\n" + str(entry) for entry in tail_catalog), encoding="utf-8")
    print(f"{args.lang}: {done} written, {problems} rejected")
    return 1 if problems else 0


def command_check(args):
    failed = 0
    for lang in LANGUAGES:
        catalog, owned = titaned_entries(po_path(lang, args.domain))
        missing = bad = 0
        for entry in catalog:
            if (entry.msgctxt, entry.msgid) not in owned:
                continue
            if not entry.translated():
                missing += 1
            elif not entry.msgid_plural and not same_placeholders(entry.msgid, entry.msgstr):
                bad += 1
                print(f"  {lang}: placeholders differ: {entry.msgid!r}")
        print(f"{lang:7} TitanEd entries {len(owned):5}  untranslated {missing:5}  placeholder problems {bad}")
        failed += missing + bad
    return 1 if failed else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--domain", default="django", choices=("django", "djangojs"))
    commands = parser.add_subparsers(dest="command", required=True)
    add = commands.add_parser("add")
    add.add_argument("pot", nargs="+")
    add.add_argument("--memory", help='glob of older catalogs, "{lang}" is replaced by the language code')
    add.set_defaults(run=command_add)
    todo = commands.add_parser("todo")
    todo.add_argument("lang", choices=LANGUAGES)
    todo.set_defaults(run=command_todo)
    fill = commands.add_parser("fill")
    fill.add_argument("lang", choices=LANGUAGES)
    fill.add_argument("json")
    fill.set_defaults(run=command_fill)
    check = commands.add_parser("check")
    check.set_defaults(run=command_check)
    args = parser.parse_args()
    return args.run(args) or 0


if __name__ == "__main__":
    sys.exit(main())
