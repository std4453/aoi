# One long-lived service; no Docker daemon/socket or Kubernetes API access.
ARG CHROMIUM_IMAGE=lscr.io/linuxserver/chromium@sha256:2d32e1b2b28aa92973aa0f58c433c0b045db6e1224d7001eeaa9cde1a474ce13
FROM ${CHROMIUM_IMAGE}
USER root
RUN apt-get update -o Dir::Etc::sourcelist="sources.list.d/nodesource.sources" -o Dir::Etc::sourceparts="-" \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*
COPY broker.mjs session-runtime.mjs session-runner.py browser-worker.py capture.py proxy-tunnel.mjs /opt/aoi/
COPY chromium-policy.json /etc/chromium/policies/managed/aoi-login.json
COPY chromium.sh /defaults/autostart
COPY chromium.sh /defaults/autostart_wayland
COPY rootfs/ /
RUN chmod +x /etc/s6-overlay/s6-rc.d/svc-aoi-browser/run \
    && sed -i -e 's/listen 3000/listen 127.0.0.1:3000/' -e 's/listen 3001/listen 127.0.0.1:3001/' -e '/listen \[::\]/d' /defaults/default.conf \
    && touch /etc/s6-overlay/s6-rc.d/svc-de/down /etc/s6-overlay/s6-rc.d/svc-selkies/down \
    && rm -f /etc/s6-overlay/s6-rc.d/svc-de/dependencies.d/svc-selkies
ENV START_DOCKER=false AUTO_GPU=false PUID=1000 PGID=1000 \
    SELKIES_USE_CPU="true|locked" SELKIES_ENCODER=jpeg SELKIES_FRAMERATE=20 \
    SELKIES_MANUAL_RESOLUTION="true|locked" SELKIES_MANUAL_WIDTH=1280 SELKIES_MANUAL_HEIGHT=800 \
    SELKIES_ENABLE_AUDIO="false|locked" SELKIES_ENABLE_MICROPHONE="false|locked" \
    SELKIES_FILE_TRANSFERS=none SELKIES_COMMAND_ENABLED=false \
    HARDEN_DESKTOP=true DISABLE_IPV6=true RESTART_APP=false \
    PYTHONDONTWRITEBYTECODE=1
EXPOSE 43129 43130
HEALTHCHECK --interval=15s --timeout=3s --start-period=45s \
    CMD node -e "fetch('http://127.0.0.1:43129/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
