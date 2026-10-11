#!/bin/sh
set -eu

# Fail fast if required auth env vars are missing, rather than running
# bd init and the full Node startup path only to fail deep in src/app.ts.
missing=""
for var in AUTH_JWKS_URL AUTH_ISSUER AUTH_AUDIENCE; do
  eval "value=\${$var:-}"
  if [ -z "$value" ]; then
    missing="$missing $var"
  fi
done
if [ -n "$missing" ]; then
  echo "entrypoint.sh: missing required environment variable(s):$missing" >&2
  exit 1
fi

: "${BEADS_PROJECT_DIR:=/data/project}"
: "${BEADS_DIR:=$BEADS_PROJECT_DIR/.beads}"
export BEADS_PROJECT_DIR BEADS_DIR
mkdir -p "$BEADS_PROJECT_DIR"
cd "$BEADS_PROJECT_DIR"
# In HTTP execution mode (BD_SERVE_URL set) this container never execs `bd`
# itself -- every call goes to the bd serve sidecar over HTTP -- so it needs
# no local embedded-Dolt workspace. Beads performs the existing-store check.
# Never infer initialization from an export file or reinitialize an existing
# database on a container restart.
if [ -z "${BD_SERVE_URL:-}" ]; then
  bd init --init-if-missing --prefix=task --skip-agents --skip-hooks --non-interactive
fi
cd /app
exec "$@"
