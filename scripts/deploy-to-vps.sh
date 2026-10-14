#!/usr/bin/env bash
# Run on the Hostinger VPS. Deploy a reviewed exact GitHub commit.
# Usage: bash deploy-to-vps.sh <40-character-reviewed-commit-sha>
set -euo pipefail
umask 077
SHA="${1:-}"
if [[ ! "${SHA}" =~ ^[a-f0-9]{40}$ ]]; then
  echo "A full 40-character Git commit SHA is required" >&2
  exit 2
fi
CONTAINER="${AIR_AGENT_CONTAINER:-air-agent-app-1}"
if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "Container $CONTAINER not found. Do not recreate the stack without backing up its data volume." >&2
  exit 3
fi
if [[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER")" != "true" ]]; then
  echo "Container is stopped. Investigate before deploying." >&2
  exit 4
fi
GIT_PATH="/srv/app"
PREVIOUS="$(docker exec "$CONTAINER" git -C "$GIT_PATH" rev-parse HEAD)"
if [[ ! "$PREVIOUS" =~ ^[a-f0-9]{40}$ ]]; then
  echo "Could not determine current application commit" >&2
  exit 5
fi
if [[ "$PREVIOUS" == "$SHA" ]]; then
  echo "Requested commit already running: $SHA"
  exit 0
fi
# Credentials and chat histories are sensitive: keep backups root-only.
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_ROOT="/root/air-agent-backups"
mkdir -p "$BACKUP_ROOT"
chmod 700 "$BACKUP_ROOT"
DEST="${BACKUP_ROOT}/${STAMP}-${PREVIOUS:0:10}"
mkdir -m 700 "$DEST"
echo "$PREVIOUS" > "$DEST/previous.sha"
docker cp "$CONTAINER:/data" "$DEST/data"
chmod -R go-rwx "$DEST"
echo "Root-only data backup created at $DEST; encrypt the underlying volume/offsite backups."
# Do not pull latest main: check out only the explicitly approved object.
docker exec "$CONTAINER" git -C "$GIT_PATH" fetch --no-tags --depth=1 origin "$SHA"
docker exec "$CONTAINER" git -C "$GIT_PATH" checkout --detach --force "$SHA"
docker restart "$CONTAINER" >/dev/null
sleep 8
if [[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER")" != "true" ]]; then
  echo "Container did not stay running; restore previous SHA $PREVIOUS" >&2
  exit 6
fi
RUNNING="$(docker exec "$CONTAINER" git -C "$GIT_PATH" rev-parse HEAD)"
if [[ "$RUNNING" != "$SHA" ]]; then
  echo "Unexpected deployed commit: $RUNNING" >&2
  exit 7
fi
echo "Air Agent now runs reviewed commit $RUNNING"
echo "Validate dashboard over HTTPS, login, reply rules and disposable-number QR linking."
echo "To roll back: docker exec $CONTAINER git -C $GIT_PATH checkout --detach $PREVIOUS && docker restart $CONTAINER"
