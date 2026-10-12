#!/usr/bin/env bash
# Pull an MFE's translations from a LOCAL checkout of TitanEd/openedx-translations, for `tutor dev`.
#
# Production images run `make pull_translations` (atlas pulls from GitHub at build time), but a dev
# container bind-mounts the MFE source, so nothing is pulled and every string shows in English. This
# script does what atlas does, from the checkout on disk, so uncommitted translations can be checked
# before they are pushed:
#   1. reads the `translations/<dir>:<name>` mappings of the MFE's `make pull_translations` target,
#   2. copies each `<checkout>/translations/<dir>` into `src/i18n/messages/<name>`,
#   3. regenerates `src/i18n/index.js` with frontend-platform's intl-imports.js.
# The running webpack dev server picks the files up on its own.
#
# Usage: openedx-translations/scripts/tels_pull_mfe_translations.sh <mfe directory> [<openedx-translations checkout>]
#        (default checkout: ../openedx-translations relative to the MFE's parent folder, i.e. the
#        workspace layout tels_verawood/mfes/<mfe> + tels_verawood/openedx-translations)
#
# `src/i18n/messages/` is git-ignored in the TitanEd MFEs; `src/i18n/index.js` is regenerated and shows
# as modified: do not commit it (the image build regenerates it anyway).
set -euo pipefail

mfe_dir="${1:?usage: $0 <mfe directory> [<openedx-translations checkout>]}"
mfe_dir="$(cd "$mfe_dir" && pwd)"
checkout="${2:-$(dirname "$(dirname "$mfe_dir")")/openedx-translations}"
checkout="$(cd "$checkout" && pwd)"

[ -f "$mfe_dir/Makefile" ] || { echo "No Makefile in $mfe_dir" >&2; exit 1; }
[ -d "$checkout/translations" ] || { echo "No translations/ in $checkout" >&2; exit 1; }
intl_imports="$mfe_dir/node_modules/.bin/intl-imports.js"
[ -x "$intl_imports" ] || { echo "Run npm ci in $mfe_dir first ($intl_imports missing)" >&2; exit 1; }

mappings=$(sed -n '/^pull_translations:/,/^$/p' "$mfe_dir/Makefile" \
  | grep -o 'translations/[^ :]*:[A-Za-z0-9_-]*' || true)
[ -n "$mappings" ] || { echo "No atlas mappings found in $mfe_dir/Makefile" >&2; exit 1; }

messages_dir="$mfe_dir/src/i18n/messages"
mkdir -p "$messages_dir"
names=()
for mapping in $mappings; do
  from="${mapping%%:*}"
  name="${mapping##*:}"
  if [ ! -d "$checkout/$from" ]; then
    echo "skip $name: $checkout/$from does not exist" >&2
    continue
  fi
  rm -rf "${messages_dir:?}/$name"
  mkdir -p "$messages_dir/$name"
  cp "$checkout/$from"/*.json "$messages_dir/$name/"
  names+=("$name")
  echo "pulled $from -> src/i18n/messages/$name ($(ls "$messages_dir/$name" | wc -l) files)"
done

(cd "$mfe_dir" && node "$intl_imports" "${names[@]}")
echo "regenerated $mfe_dir/src/i18n/index.js for: ${names[*]}"
