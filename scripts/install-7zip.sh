#!/bin/sh
# Install the same complete, checksum-pinned decoder in CI and runtime images.
set -eu
destination=${1:?Usage: install-7zip.sh DESTINATION_DIRECTORY}
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) archive=7z2603-linux-x64.tar.xz; digest=dc99eff5008f1ab79bd7084c68513701547a808a89502bf4133683535ab3c695 ;;
  Linux-aarch64|Linux-arm64) archive=7z2603-linux-arm64.tar.xz; digest=2389ba20e4d8295e8709c20b6263b69bd1ec4972fe38a04ad7a1badbf595b996 ;;
  Darwin-arm64|Darwin-x86_64) archive=7z2603-mac.tar.xz; digest=5ca87677072c59f5602e5c49baa27d4694bacd2259b4e507f0094249d4281480 ;;
  *) echo 'Unsupported platform for the pinned 7-Zip release' >&2; exit 1 ;;
esac
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
curl --fail --location --retry 3 --connect-timeout 15 --max-time 180 \
  "https://github.com/ip7z/7zip/releases/download/26.03/$archive" -o "$temporary/package.tar.xz"
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$temporary/package.tar.xz" | cut -d ' ' -f 1)
else
  actual=$(shasum -a 256 "$temporary/package.tar.xz" | cut -d ' ' -f 1)
fi
[ "$actual" = "$digest" ] || { echo '7-Zip release checksum mismatch' >&2; exit 1; }
tar -xJf "$temporary/package.tar.xz" -C "$temporary"
mkdir -p "$destination"
install -m 755 "$temporary/7zz" "$destination/7z"
# Preserve the upstream license alongside redistributed executables.
cp "$temporary/License.txt" "$destination/7zip-LICENSE.txt"
"$destination/7z" i
