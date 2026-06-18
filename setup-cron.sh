#!/usr/bin/env bash
# Installs a cron job to run the wedding sweep every 2 hours.
# Usage: ./setup-cron.sh        (run once, from the project root)
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE="$(command -v node || true)"

if [ -z "$NODE" ]; then
  echo "✗ node not found in PATH. Install Node.js first (https://nodejs.org), then re-run."
  exit 1
fi
if [ ! -f "$DIR/.env" ]; then
  echo "✗ No .env found in $DIR — add it before scheduling (the sweep needs the credentials)."
  exit 1
fi

mkdir -p "$DIR/logs"
SWEEP_LINE="0 */2 * * * cd $DIR && $NODE src/sweep.js >> $DIR/logs/cron.log 2>&1"
STATUS_LINE="0 10 * * * cd $DIR && $NODE src/status.js >> $DIR/logs/cron.log 2>&1"

# Replace any existing sweep/status entries, keep everything else
( crontab -l 2>/dev/null | grep -vE "src/(sweep|status)\.js" || true; echo "$SWEEP_LINE"; echo "$STATUS_LINE" ) | crontab -

echo "✓ Scheduled (while your laptop is awake):"
echo "  • Sweep — every 2 hours"
echo "  • Status board — daily at 10:00 (laptop local time)"
echo
echo "  $SWEEP_LINE"
echo "  $STATUS_LINE"
echo
echo "Useful commands:"
echo "  crontab -l                 # see scheduled jobs"
echo "  tail -f \"$DIR/logs/cron.log\"   # watch sweep output"
echo "  crontab -e                 # edit/remove (delete the sweep line to stop)"
