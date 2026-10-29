#!/usr/bin/env bash
# Build and (re)start the control plane as abx-cp. Run as root: sudo bash infra/cp/deploy.sh
# Prerequisite: sudo bash infra/cp/secrets.sh
#
# Worker/agent-socket note: /run/agentbox/agent.sock is 0600 abx-cp. In rootless podman the pod's
# UserNS=keep-id:uid=1000,gid=1000 maps host abx-cp to container uid 1000 ("node", non-root), so the
# worker can open the socket without running as container root. The parent directory is mounted
# (not the socket file) so a recreated socket is visible after an agent restart.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../.." && pwd)
. "$here/lib.sh"

BASE_DOMAIN=${AGENTBOX_BASE_DOMAIN:-agentbox.io.vn}
[[ "$BASE_DOMAIN" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || { echo "invalid AGENTBOX_BASE_DOMAIN" >&2; exit 1; }
ensure_cp_manager

for s in better_auth_secret encryption_key postgres_password database_url agent_token; do
  secret_exists "$s" || { echo "missing secret $s: run infra/cp/secrets.sh first" >&2; exit 1; }
done
[ -f "$CP_HOME/optional.env" ] || { echo "missing optional.env: run infra/cp/secrets.sh first" >&2; exit 1; }

# Directories (the agent normally creates /run/agentbox via RuntimeDirectory; precreating is harmless).
install -d -m 0711 /run/agentbox
install -d -o "$CP_USER" -g "$CP_USER" -m 0700 "$CP_HOME/pg" "$CP_HOME/build"
install -d -o "$CP_USER" -g "$CP_USER" -m 0755 "$CP_HOME/caddy" "$CP_HOME/.config" "$CP_HOME/.config/containers" "$QUADLET_DIR"

# cp.env: non-secret settings shared by web, worker and caddy.
printf 'AGENTBOX_BASE_DOMAIN=%s\n' "$BASE_DOMAIN" > "$CP_HOME/cp.env"
chown "$CP_USER:$CP_USER" "$CP_HOME/cp.env"; chmod 0644 "$CP_HOME/cp.env"

# Marketing landing (apps/landing): build it first as your own user (`pnpm --filter @agentbox/landing build`;
# sudo resets PATH, so this script does not build it), then the static dist/ is copied to $CP_HOME/landing
# for Caddy (mounted read-only at /srv/landing).
landing_dist=$repo/apps/landing/dist
[ -f "$landing_dist/index.html" ] || { echo "missing $landing_dist: run 'pnpm --filter @agentbox/landing build' first" >&2; exit 1; }
echo "== publishing landing to $CP_HOME/landing"
rm -rf --one-file-system "$CP_HOME/landing.new"
install -d -o "$CP_USER" -g "$CP_USER" -m 0755 "$CP_HOME/landing.new"
cp -a "$landing_dist/." "$CP_HOME/landing.new/"
chown -R "$CP_USER:$CP_USER" "$CP_HOME/landing.new"
rm -rf --one-file-system "$CP_HOME/landing"
mv "$CP_HOME/landing.new" "$CP_HOME/landing"

# Stage the build context: /home/kyle is not readable by abx-cp, so copy the tree (no node_modules etc).
src=$CP_HOME/build/src
rm -rf --one-file-system "$src"
install -d -o "$CP_USER" -g "$CP_USER" -m 0700 "$src"
tar -C "$repo" -c \
  --no-anchored --exclude=node_modules --exclude=.next --exclude=dist --exclude=.turbo \
  --exclude=coverage --exclude='*.log' --exclude=.env --exclude='.env.*' --exclude=.git --exclude=.work \
  --anchored --exclude=./docs --exclude=./images --exclude=./infra/host . \
  | tar -C "$src" -x --no-same-owner
install -o "$CP_USER" -g "$CP_USER" -m 0644 "$here/containerignore" "$src/.containerignore"
chown -R "$CP_USER:$CP_USER" "$src"

echo "== building images as $CP_USER"
for name in web worker; do
  abxcp podman build --ignorefile "$src/.containerignore" \
    -f "$src/infra/cp/Containerfile.$name" -t "localhost/agentbox-$name:latest" "$src"
done

echo "== installing quadlets and Caddyfile"
for f in "$here"/quadlet/*; do
  install -o "$CP_USER" -g "$CP_USER" -m 0644 "$f" "$QUADLET_DIR/$(basename "$f")"
done
install -o "$CP_USER" -g "$CP_USER" -m 0644 "$here/Caddyfile" "$CP_HOME/caddy/Caddyfile"

# cloudflared only runs when its token secret exists.
if secret_exists cloudflared_token; then
  install -o "$CP_USER" -g "$CP_USER" -m 0644 /dev/null "$CP_HOME/cloudflared.enabled"
  tunnel=1
else
  rm -f "$CP_HOME/cloudflared.enabled"
  tunnel=0
  echo "cloudflared_token secret absent: tunnel unit skipped"
fi

abxcp_ctl daemon-reload
units=(agentbox-caddy agentbox-worker agentbox-web agentbox-postgres agentbox-cloudflared)
abxcp_ctl stop "${units[@]/%/.service}" agentbox-cp-pod.service 2>/dev/null || true
abxcp_ctl start agentbox-postgres.service agentbox-web.service agentbox-worker.service agentbox-caddy.service
if [ "$tunnel" = 1 ]; then abxcp_ctl start agentbox-cloudflared.service; fi
abxcp_ctl --no-pager status agentbox-cp-pod.service agentbox-postgres.service agentbox-web.service \
  agentbox-worker.service agentbox-caddy.service agentbox-cloudflared.service | grep -E '^(●|○|\s+Active:)' || true
