#!/bin/bash
set -e

echo "Installing Python dependencies from requirements.txt files..."

find /app -type f -name "requirements.txt" -exec pip install --no-cache-dir -r {} \;

echo "Python dependencies installed."

# Outgoing-IP rotation over a routed IPv6 subnet: install an AnyIP local route
# so the kernel lets us bind() any address inside the prefix (source-IP mode in
# [Network] then rotates across it). No-op unless PUBLOADER_ANYIP_SUBNET is set;
# needs NET_ADMIN + net.ipv6.ip_nonlocal_bind=1 (see docker-compose.yml). Best
# effort — a failure here (missing cap, no `ip`) is logged, not fatal.
if [ -n "${PUBLOADER_ANYIP_SUBNET:-}" ]; then
    ANYIP_DEV="${PUBLOADER_ANYIP_DEV:-eth0}"
    echo "Adding AnyIP local route ${PUBLOADER_ANYIP_SUBNET} dev ${ANYIP_DEV}..."
    if ip -6 route replace local "${PUBLOADER_ANYIP_SUBNET}" dev "${ANYIP_DEV}"; then
        echo "AnyIP route installed."
    else
        echo "AnyIP route setup failed (continuing; check NET_ADMIN + IPv6 routing)."
    fi
fi

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
