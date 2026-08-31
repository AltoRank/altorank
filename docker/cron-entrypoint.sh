#!/bin/sh
# Scheduler sidecar for the self-hosted deployment.
#
# The app container serves the eight cron routes but nothing calls them: on
# Vercel that is the platform's job, and self-hosting had no equivalent. So the
# $0 rung shipped the product without the automation that is the product's whole
# proposition. This closes that.
#
# One helper plus BusyBox crond, rather than a scheduler dependency: the jobs are
# HTTP calls on a fixed schedule, and anything heavier would be a second thing to
# keep in sync with vercel.json.

set -eu

APP_URL="${APP_URL:-http://web:3000}"

if [ -z "${CRON_SECRET:-}" ]; then
  # Fail loudly and stay down. The routes would reject every request anyway, so a
  # silently-running scheduler would look healthy while doing nothing at all,
  # which is the failure mode hardest to notice.
  echo "cron: CRON_SECRET is not set. The scheduled jobs would be rejected by" >&2
  echo "cron: every route, so this container will not pretend to run them." >&2
  echo "cron: Set CRON_SECRET in docker/.env and restart." >&2
  exit 1
fi

# Called by crontab as `altorank-cron <job>`.
cat > /usr/local/bin/altorank-cron <<'HELPER'
#!/bin/sh
set -u
job="$1"
url="${APP_URL:-http://web:3000}/api/cron/${job}"
start=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# --max-time is below the shortest interval (10 min) so a hung request cannot
# still be running when the next tick fires.
if body=$(curl -fsS --max-time 540 -H "x-cron-secret: ${CRON_SECRET}" "$url" 2>&1); then
  echo "[$start] cron/$job ok ${body}" | head -c 2000
  echo
else
  echo "[$start] cron/$job FAILED: ${body}" >&2
fi
HELPER
chmod +x /usr/local/bin/altorank-cron

# crond runs in its own environment, so hand the two variables the helper needs
# to every job rather than relying on inheritance.
{
  echo "APP_URL=${APP_URL}"
  echo "CRON_SECRET=${CRON_SECRET}"
  cat /etc/altorank/crontab
} > /etc/crontabs/root

echo "cron: scheduling 8 jobs against ${APP_URL}"

# Wait for the app to answer before the first tick, so a cold start does not
# produce a misleading failure in the log.
i=0
while [ "$i" -lt 60 ]; do
  if curl -fsS --max-time 5 -o /dev/null "${APP_URL}/" 2>/dev/null; then
    echo "cron: app is up"
    break
  fi
  i=$((i + 1))
  sleep 2
done

# -f foreground, -d 8 log to stderr so `docker compose logs` shows job output.
exec crond -f -d 8
