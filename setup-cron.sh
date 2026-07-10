#!/usr/bin/env bash
# Installs a cron job to post the daily wedding status board at 10:00.
# Usage: ./setup-cron.sh        (run once, from the project root)
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE="$(command -v node || true)"

if [ -z "$NODE" ]; then
  echo "✗ node not found in PATH. Install Node.js first (https://nodejs.org), then re-run."
  exit 1
fi
if [ ! -f "$DIR/.env" ]; then
  echo "✗ No .env found in $DIR — add it before scheduling (the status board needs the credentials)."
  exit 1
fi

mkdir -p "$DIR/logs"
STATUS_LINE="0 10 * * * cd $DIR && $NODE src/status.js >> $DIR/logs/cron.log 2>&1"

# Install the daily status job. The grep also strips any previously-installed
# per-2-hours sweep entry, so re-running this turns the old email-by-email
# alerts off and leaves only the 10:00 daily summary.
( crontab -l 2>/dev/null | grep -vE "src/(sweep|status)\.js" || true; echo "$STATUS_LINE" ) | crontab -

echo "✓ Scheduled (while your laptop is awake):"
echo "  • Status board — daily at 10:00 (laptop local time)"
echo
echo "  $STATUS_LINE"
echo
echo "  (Per-email sweep alerts are no longer scheduled. Run them on demand"
echo "   anytime with 'npm run sweep' if you ever want a mid-day check.)"
echo
echo "Useful commands:"
echo "  crontab -l                 # see scheduled jobs"
echo "  tail -f \"$DIR/logs/cron.log\"   # watch output"
echo "  crontab -e                 # edit/remove scheduled jobs"
