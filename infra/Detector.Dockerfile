ARG IMAGE_PREFIX=
FROM ${IMAGE_PREFIX}python:3.12.14-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e
RUN pip install --no-cache-dir uv==0.12.23
RUN useradd --create-home detector
WORKDIR /workspace
COPY --chown=detector:detector services/detector services/detector
COPY --chown=detector:detector packages/contracts packages/contracts
USER detector
WORKDIR /workspace/services/detector
ENV UV_PYTHON_DOWNLOADS=never
RUN uv sync --locked --no-dev
CMD ["uv", "run", "--no-sync", "sentinel-detector"]
