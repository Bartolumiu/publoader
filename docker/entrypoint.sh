#!/bin/bash
set -e

echo "Installing Python dependencies from requirements.txt files..."

find /app -type f -name "requirements.txt" -exec pip install --no-cache-dir -r {} \;

echo "Python dependencies installed."

# Sync extensions from each bind-mounted source repo into the runtime dir.
# Replaces the publoader-extensions/-private sidecars: putting it in the main
# entrypoint means a `docker compose restart publoader` re-syncs in one step
# (after `git pull` on host), and watchtower-driven restarts of the publoader
# image pick up extension changes too.
#
# Only runs if `/app/sync_extensions.py` is present (mounted via compose) and
# `/sources/` has at least one subdirectory with `src/`. Bot/dev runs skip
# this transparently.
if [ -f /app/sync_extensions.py ] && [ -d /sources ]; then
    for src in /sources/*/; do
        [ -d "${src}src" ] || continue
        echo "Syncing extensions from ${src}..."
        python /app/sync_extensions.py "${src}" || echo "sync failed for ${src} (continuing)"
    done
fi

if [ "$#" -eq 0 ]; then
    exec python run.py
else
    exec "$@"
fi
