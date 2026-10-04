#!/bin/sh
# Replace the image's wrapper: keep Chromium's normal sandbox and certificate checks.
if [ "${PIXELFLUX_WAYLAND}" = "true" ]; then
  set -- --ozone-platform=wayland
fi
while [ ! -f /config/aoi-proxy-enabled ]; do sleep 0.2; done
if [ -f /config/aoi-proxy-enabled ]; then
  set -- "$@" --proxy-server=http://127.0.0.1:9223
fi
exec /usr/bin/chromium \
  --user-data-dir=/config/aoi-profile \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  --no-first-run --no-default-browser-check --disable-gpu \
  --start-maximized \
  "$@" \
  about:blank \
  >/dev/null 2>&1
