#!/bin/bash
# Signs a built Helm Core.app with one stable local identity so macOS (Full Disk Access, mic, etc.) sees the same app across
# updates. Ad-hoc signatures change every build, which made macOS forget permissions. Creates the identity once.
set -euo pipefail
app="${1:?usage: sign-macos.sh path/to/Helm Core.app}"
name='Helm Local Signing'
keychain="$HOME/Library/Keychains/login.keychain-db"

if ! security find-certificate -c "$name" "$keychain" >/dev/null 2>&1; then
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  cat > "$work/cert.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $name
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
EOF
  /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 7300 -config "$work/cert.cnf" \
    -keyout "$work/key.pem" -out "$work/cert.pem" 2>/dev/null
  pass=$(/usr/bin/openssl rand -hex 16)
  /usr/bin/openssl pkcs12 -export -inkey "$work/key.pem" -in "$work/cert.pem" -name "$name" \
    -out "$work/id.p12" -passout "pass:$pass"
  security import "$work/id.p12" -k "$keychain" -P "$pass" -T /usr/bin/codesign >/dev/null
  echo "Created signing identity: $name"
fi

# Sign by certificate hash: unambiguous, and works for a self-signed (untrusted) identity.
hash=$(security find-certificate -c "$name" -Z "$keychain" | awk '/SHA-1 hash:/ {print $3; exit}')
# --deep signs the nested helpers and frameworks inside-out; each bundle keeps its own identifier.
codesign --force --deep --sign "$hash" "$app"
codesign --verify --deep --strict "$app"
codesign -dr - "$app" 2>&1 | grep designated
