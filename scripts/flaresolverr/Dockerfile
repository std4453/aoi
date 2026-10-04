# Official multi-architecture FlareSolverr 3.5.2, pinned for reproducible patches.
ARG BASE_IMAGE=ghcr.io/flaresolverr/flaresolverr@sha256:c80ae007ce2ccdcd217a12426e4f039ef763ff90738c808d38810c3e59323767
FROM ${BASE_IMAGE}
USER root
COPY patch.py /tmp/aoi-patch.py
RUN python /tmp/aoi-patch.py && rm /tmp/aoi-patch.py
USER flaresolverr
ENV LOG_LEVEL=error LOG_HTML=false DISABLE_MEDIA=true
