FROM node:24-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
COPY content/examples/ /src/content/examples/
RUN npm run build

FROM python:3.13-slim AS runtime
# PORT: hosts such as Render supply their own value at run time; 8000 is only the local default.
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8000
# Privacy-conscious default: no generation ledger or saved provider replies inside the container
# (the non-root user cannot write /app/var). Set BALLIGH_LEDGER_DIR to a provisioned writable path to enable it.
ENV BALLIGH_LEDGER_DIR=off
WORKDIR /app
COPY server/requirements.txt server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt
COPY server/balligh server/balligh
COPY content content
COPY --from=web /src/web/dist web/dist
# Licence and notice texts travel with the image (they are not part of web/dist):
# the project's MIT licence, third-party notices, the library source notices and the bundled fonts' SIL OFL texts.
COPY LICENSE THIRD_PARTY_NOTICES.md /app/licenses/
COPY content/notices/ /app/licenses/content-notices/
COPY web/src/design/fonts/OFL-*.txt /app/licenses/fonts/
RUN useradd --create-home --uid 10001 balligh
USER balligh
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD python -c "import os,urllib.request;urllib.request.urlopen('http://127.0.0.1:%s/api/health' % (os.environ.get('PORT') or '8000'), timeout=4)"
# One uvicorn process (no --workers): the two-request generation admission limit is per process.
CMD ["sh", "-c", "exec uvicorn --app-dir server --factory balligh.api:create_app --host 0.0.0.0 --port ${PORT:-8000}"]
