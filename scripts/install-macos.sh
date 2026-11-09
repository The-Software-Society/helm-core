#!/bin/bash
# Build with pnpm update:prepare first. Installs for this user; no sudo or developer tools needed at login.
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
source_app="$repo_dir/release/mac-arm64/Helm Core.app"
install_dir="$HOME/Applications"
installed_app="$install_dir/Helm Core.app"
agent_file="$HOME/Library/LaunchAgents/io.helm-core.app.plist"
label="io.helm-core.app"
domain="gui/$(id -u)"
if [[ "${1:-}" == '--disable-login' ]]; then
  launchctl bootout "$domain/$label" 2>/dev/null || true
  if [[ -f "$agent_file" ]]; then mv "$agent_file" "$agent_file.disabled"; fi
  echo 'Helm launch at login disabled. App and workspace preserved.'
  exit 0
fi
[[ -x "$source_app/Contents/MacOS/Helm Core" ]] || { echo 'Run pnpm update:prepare first.' >&2; exit 1; }
mkdir -p "$install_dir" "$(dirname "$agent_file")"
python3 "$repo_dir/scripts/helm-update.py" install "$source_app"   --data "$HOME/Library/Application Support/Helm Core" --target "$installed_app"
python3 - "$installed_app" "$agent_file" <<'PY'
import plistlib, sys
with open(sys.argv[2], 'wb') as f:
    plistlib.dump({'Label': 'io.helm-core.app',
                  'ProgramArguments': ['/usr/bin/open', '-n', '-a', sys.argv[1]],
                  'RunAtLoad': True, 'LimitLoadToSessionType': 'Aqua'}, f)
PY
chmod 644 "$agent_file"
plutil -lint "$agent_file"
launchctl bootout "$domain/$label" 2>/dev/null || true
launchctl enable "$domain/$label"
launchctl bootstrap "$domain" "$agent_file"
echo "Installed: $installed_app"
echo "Launch at login: $agent_file"
launchctl print "$domain/$label"
