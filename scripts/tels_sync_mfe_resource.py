#!/usr/bin/env python3
"""
Sync a TitanEd MFE translation resource with the strings extracted from its source code.

TitanEd keeps its own MFE resources in this repository (``translations/frontend-app-tels-public``,
``translations/frontend-app-tels-public-template-2``) and the TELS keys of the shared header and footer
components (``tels.*``, ``indigo.*``, ``account.user.menu.*``, ``generic.*`` in
``translations/frontend-component-header`` and ``translations/frontend-component-footer``). Transifex does not
extract these; the workflow is:

1. In the MFE: ``make extract_translations`` (writes ``src/i18n/transifex_input.json``), or for the Tutor
   plugin components ``formatjs extract 'tutorindigo/components/*.jsx' --out-file plugin.json``.
2. Here: ``python scripts/tels_sync_mfe_resource.py translations/<resource> <extracted.json> [--merge]``.
   ``--merge`` keeps the keys the resource already has (for the shared header/footer resources, whose
   upstream keys are not in the extracted file); without it, keys that left the source are removed from
   ``transifex_input.json`` and from every language file.
3. Translate the keys the script lists as missing (``messages/<lang>.json``), validate (``make
   validate_translation_files``), commit, push, and rebuild the MFE images (``tutor images build mfe``) so
   ``atlas pull`` picks the new files up.

The extracted file may be ``{id: "English"}`` (transifex_input.json), ``{id: {defaultMessage, description}}``
(``formatjs extract``) or a list of ``{id, defaultMessage}`` (babel-plugin-formatjs).
"""
import argparse
import json
import pathlib
import sys

REPORT_LANGUAGES = ("hi", "ar", "es_419")


def load_source(path):
    data = json.load(open(path, encoding="utf-8"))
    if isinstance(data, list):
        return {entry["id"]: entry["defaultMessage"] for entry in data}
    return {key: (value["defaultMessage"] if isinstance(value, dict) else value) for key, value in data.items()}


def dump(path, data):
    with open(path, "w", encoding="utf-8") as handle:
        if data:
            json.dump(data, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        else:
            handle.write("{}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("resource", help="resource directory, e.g. translations/frontend-app-tels-public")
    parser.add_argument("extracted", help="strings extracted from the MFE or plugin source")
    parser.add_argument("--merge", action="store_true", help="keep keys the resource has but the source lacks")
    parser.add_argument("--report", default=",".join(REPORT_LANGUAGES), help="languages to report on")
    args = parser.parse_args()

    resource = pathlib.Path(args.resource)
    i18n_dir = resource / "src" / "i18n"
    messages_dir = i18n_dir / "messages"
    input_path = i18n_dir / "transifex_input.json"
    messages_dir.mkdir(parents=True, exist_ok=True)

    source = load_source(args.extracted)
    current = json.load(open(input_path, encoding="utf-8")) if input_path.exists() else {}
    merged = dict(current) if args.merge else {}
    changed = [key for key in source if key in current and current[key] != source[key]]
    added = [key for key in source if key not in current]
    removed = [] if args.merge else [key for key in current if key not in source]
    merged.update(source)
    dump(input_path, merged)
    print(f"{input_path}: {len(merged)} keys (+{len(added)} added, {len(changed)} changed, -{len(removed)} removed)")

    report = [lang.strip() for lang in args.report.split(",") if lang.strip()]
    for lang_file in sorted(messages_dir.glob("*.json")):
        text = open(lang_file, encoding="utf-8").read().strip()
        translations = json.loads(text) if text else {}
        kept = dict(translations) if args.merge else {key: value for key, value in translations.items() if key in merged}
        # A translation of an English text that changed is stale: drop it so the fallback is the new English.
        for key in changed:
            kept.pop(key, None)
        if kept != translations:
            dump(lang_file, kept)
        lang = lang_file.stem
        if lang in report:
            missing = [key for key in merged if key not in kept]
            print(f"  {lang}: {len(kept)} translated, {len(missing)} missing")
            for key in missing:
                print(f"     - {key}: {merged[key][:70]!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
