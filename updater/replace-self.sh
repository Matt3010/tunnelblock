#!/bin/sh
set -eu

cd /workspace

EXPECTED_GENERATION="${EXPECTED_UPDATER_GENERATION:-2}"
DELAY_SEC="${UPDATER_REPLACE_DELAY_SEC:-5}"

sleep "$DELAY_SEC"

echo "Replacing updater container..."
docker compose up -d --no-deps --force-recreate updater

for i in $(seq 1 45); do
  CID="$(docker compose ps -q updater 2>/dev/null || true)"

  if [ -n "$CID" ]; then
    STATE="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CID" 2>/dev/null || true)"

    if [ "$STATE" = "healthy" ]; then
      if docker exec "$CID" node -e '
        const expected = process.argv[1];
        fetch("http://127.0.0.1:8090/status", {
          headers: { authorization: "Bearer " + process.env.ADMIN_API_TOKEN }
        })
          .then(async response => {
            if (!response.ok) process.exit(2);
            const status = await response.json();
            process.exit(status.runtimeGeneration === expected ? 0 : 3);
          })
          .catch(() => process.exit(4));
      ' "$EXPECTED_GENERATION"; then
        echo "Updater runtime generation $EXPECTED_GENERATION is healthy and verified through /status."
        exit 0
      fi
    fi
  fi

  sleep 1
done

echo "ERROR: updater replacement did not produce verified generation $EXPECTED_GENERATION."
docker compose ps --all updater || true
docker compose logs --no-color --tail=120 updater || true
exit 33
