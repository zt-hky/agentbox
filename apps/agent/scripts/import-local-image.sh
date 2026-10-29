#!/usr/bin/env bash
# Import an image from the *invoking user's* podman storage as a shared rootfs, running the same
# fixups the agent's build path applies (`agent.mjs --prepare-rootfs`).
# Usage: apps/agent/scripts/import-local-image.sh localhost/agentbox-workspace:dev
# Needs sudo for tar and the fixups; prints the imageId (= directory name under /srv/agentbox/rootfs).
set -euo pipefail
ref="${1:?image reference}"
id="$(podman image inspect --format '{{.Id}}' "$ref")"
[[ "$id" =~ ^[0-9a-f]{64}$ ]] || { echo "unexpected image id: $id" >&2; exit 1; }
dir="/srv/agentbox/rootfs/$id"
if [ -d "$dir" ]; then echo "rootfs $id exists; re-applying fixups" >&2; else
  tmp="/srv/agentbox/rootfs/.tmp-import-$$"
  cname="abx-import-$$"
  sudo install -d -m 0755 "$tmp"
  trap 'podman rm -f "$cname" >/dev/null 2>&1 || true; sudo rm -rf --one-file-system "$tmp"' EXIT
  podman create --name "$cname" "$ref" /bin/true >/dev/null
  podman export "$cname" | sudo tar -x --no-same-owner -C "$tmp"
  sudo mv "$tmp" "$dir"
fi
sudo /usr/bin/node /opt/agentbox/agent/agent.mjs --prepare-rootfs "$dir"
echo "$id"
