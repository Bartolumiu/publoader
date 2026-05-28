#!/bin/bash
set -e

echo "Installing Python dependencies from requirements.txt files..."

find /app -type f -name "requirements.txt" -exec pip install --no-cache-dir -r {} \;

echo "Python dependencies installed."

# Bootstrap an empty extensions volume on first deploy: PubloaderUpdater
# pulls all configured repos from GitHub (PAT-authed) and lays files into
# /app. Idempotent — re-runs are no-ops once SHAs match.
if [ -z "$(ls -A /app/publoader/extensions/src 2>/dev/null)" ]; then
    echo "extensions/ is empty — bootstrapping via PubloaderUpdater..."
    python -m publoader.updater || echo "bootstrap failed (continuing)"
fi

if [ "$#" -eq 0 ]; then
    exec python run.py
else
    exec "$@"
fi
