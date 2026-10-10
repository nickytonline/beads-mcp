#!/bin/sh
set -eu
: "${BEADS_PROJECT_DIR:=/data/project}"
: "${BEADS_DIR:=$BEADS_PROJECT_DIR/.beads}"
export BEADS_PROJECT_DIR BEADS_DIR
mkdir -p "$BEADS_PROJECT_DIR"
cd "$BEADS_PROJECT_DIR"
# Beads performs the existing-store check. Never infer initialization from an
# export file or reinitialize an existing database on a container restart.
bd init --init-if-missing --prefix=task --skip-agents --skip-hooks --non-interactive
cd /app
exec "$@"
