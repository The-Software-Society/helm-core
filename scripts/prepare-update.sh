#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
manifest="release/mac-arm64/Helm Core.app/Contents/Resources/helm-release.json"
# A failed preparation never leaves a candidate marked ready.
rm -f "$manifest"
trap 'rm -f "$manifest"' ERR
source_stamp() {
  python3 - <<'PYCODE'
import hashlib
from pathlib import Path
paths = [p for root in ('src', 'scripts') for p in Path(root).rglob('*') if p.is_file() and '__pycache__' not in p.parts]
paths += [Path(p) for p in ('package.json', 'pnpm-lock.yaml', 'electron.vite.config.ts', 'tsconfig.json')]
h = hashlib.sha256()
for p in sorted(paths):
    h.update(str(p).encode() + b'\0' + p.read_bytes())
print(h.hexdigest())
PYCODE
}
starting_source=$(source_stamp)
pnpm typecheck
pnpm test
pnpm test:updates
pnpm test:recovery
pnpm dist
pnpm test:update-live
[[ "$starting_source" == "$(source_stamp)" ]] || { echo 'Source changed during verification. Prepare the update again.' >&2; rm -f "$manifest"; exit 1; }
python3 scripts/helm-update.py seal "release/mac-arm64/Helm Core.app"
# Point the installed app at this candidate so the Helm menu can install it in one click.
candidate_dir="${HELM_DATA_DIR:-$HOME/Library/Application Support/Helm Core}/updates"
mkdir -p "$candidate_dir"
python3 - "$PWD/release/mac-arm64/Helm Core.app" "$candidate_dir/candidate.json" <<'PYCODE'
import json, sys, time
app, out = sys.argv[1], sys.argv[2]
manifest = json.load(open(app + '/Contents/Resources/helm-release.json'))
json.dump({'app': app, 'sha256': manifest['sha256'], 'createdAt': manifest['createdAt'], 'recordedAt': time.time()}, open(out, 'w'), indent=2)
PYCODE
printf '\nReady: Helm → Install Tested Update… installs it in one click.\n'
