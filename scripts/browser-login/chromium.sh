#!/bin/sh
# Replace the image's wrapper: keep Chromium's normal sandbox and certificate checks.
if [ "${PIXELFLUX_WAYLAND}" = "true" ]; then
  set -- --ozone-platform=wayland
fi
# Chromium has a 500-CSS-pixel minimum window; fit it inside the phone desktop.
if [ "${AOI_BROWSER_MOBILE}" = "true" ]; then
  set -- "$@" --force-device-scale-factor=0.75
fi
while [ ! -f /config/aoi-start ]; do sleep 0.2; done
if [ -f /config/aoi-start ]; then
  set -- "$@" --proxy-server=http://127.0.0.1:9223
fi
export HOME=/config/aoi-session
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_CACHE_HOME="$HOME/.cache"
export TMPDIR="$HOME/tmp"
mkdir -p "$TMPDIR"
chmod 700 "$TMPDIR"
exec /usr/bin/chromium \
  --user-data-dir=/config/aoi-session/profile \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  --no-first-run --no-default-browser-check --disable-gpu \
  --start-maximized \
  "$@" \
  about:blank \
  >/dev/null 2>&1
