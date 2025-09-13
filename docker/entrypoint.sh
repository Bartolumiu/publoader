#!/bin/bash
set -e

# Cleanup any .mdauth files before running
echo "Removing any existing .mdauth files..."
find /app -type f -name "*.mdauth" -exec rm -f {} +
echo ".mdauth cleanup complete."

echo "Installing Python dependencies from requirements.txt files..."

# Recursively install all requirements.txt files in the app directory
find /app -type f -name "requirements.txt" | while read -r req; do
    echo "Installing dependencies from $req..."
    pip install --no-cache-dir -r "$req"
done

echo "Python dependencies installed."

# If no args were passed to the container, run the default app.
# If args were passed, execute them (so `docker run ... python run.py` works).
if [ "$#" -eq 0 ]; then
  exec python run.py
else
  exec "$@"
fi
