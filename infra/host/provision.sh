#!/usr/bin/env bash
# AgentBox host provisioning. Idempotent. Run: sudo bash infra/host/provision.sh
# Never flushes the nftables ruleset; only table `inet agentbox` is ever touched.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then echo "run as root (sudo)" >&2; exit 1; fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
FILES="$HERE/files"
TENANT_FS_SIZE="${AGENTBOX_TENANT_FS_SIZE:-300G}"
CHANGED_UNITS=0
log() { printf '[provision] %s\n' "$*"; }

# install_file <relative path under files/> <mode>; sets INSTALLED=1 if content changed.
install_file() {
  local rel="$1" mode="$2" src="$FILES/$1" dst="/$1"
  INSTALLED=0
  if [ -f "$dst" ] && cmp -s "$src" "$dst" && [ "$(stat -c %a "$dst")" = "$mode" ]; then return 0; fi
  install -D -m "$mode" -o root -g root "$src" "$dst"
  INSTALLED=1
  log "installed $dst"
}

# ---- 6.1 packages
export DEBIAN_FRONTEND=noninteractive
need=()
for p in podman passt uidmap catatonit xfsprogs nftables acl nodejs unattended-upgrades needrestart; do
  dpkg -s "$p" >/dev/null 2>&1 || need+=("$p")
done
if [ "${#need[@]}" -gt 0 ]; then
  log "apt-get install ${need[*]}"
  apt-get update -qq
  apt-get install -y "${need[@]}"
fi

# ---- 6.2 storage
install -d -m 0755 /var/lib/agentbox
if [ ! -e /var/lib/agentbox/tenants.xfs ]; then
  log "creating sparse $TENANT_FS_SIZE /var/lib/agentbox/tenants.xfs"
  truncate -s "$TENANT_FS_SIZE" /var/lib/agentbox/tenants.xfs
fi
if ! blkid -p -o value -s TYPE /var/lib/agentbox/tenants.xfs 2>/dev/null | grep -qx xfs; then
  log "mkfs.xfs"
  mkfs.xfs -q -L agentbox /var/lib/agentbox/tenants.xfs
fi
install_file usr/local/lib/agentbox/storage-up.sh 755
install_file usr/local/lib/agentbox/storage-down.sh 755
install_file etc/systemd/system/agentbox-storage.service 644; [ "$INSTALLED" = 1 ] && CHANGED_UNITS=1
[ "$CHANGED_UNITS" = 1 ] && systemctl daemon-reload
systemctl enable agentbox-storage.service >/dev/null 2>&1
systemctl is-active --quiet agentbox-storage.service || systemctl start agentbox-storage.service
mountpoint -q /srv/agentbox || { echo "/srv/agentbox is not mounted" >&2; exit 1; }
install -d -m 0711 -o root -g root /srv/agentbox/tenants
install -d -m 0755 -o root -g root /srv/agentbox/rootfs

# ---- 6.3 sysctl
install_file etc/sysctl.d/99-agentbox-hardening.conf 644
if [ "$INSTALLED" = 1 ]; then sysctl --system >/dev/null; log "sysctl applied"; fi

# ---- 6.4 module blacklist
install_file etc/modprobe.d/agentbox-blacklist.conf 644

# ---- 6.5 firewall
install -d -m 0755 /etc/agentbox
nft_src="$FILES/etc/agentbox/nftables.nft"
nft_tmp="$(mktemp)"
trap 'rm -f "$nft_tmp"' EXIT
cp "$nft_src" "$nft_tmp"
if ! nft -c -f "$nft_tmp" 2>/dev/null; then
  log "nft rejected the ruleset; retrying without newconn_rate"
  grep -v 'newconn_rate' "$nft_src" > "$nft_tmp"
  nft -c -f "$nft_tmp"
fi
if ! { [ -f /etc/agentbox/nftables.nft ] && cmp -s "$nft_tmp" /etc/agentbox/nftables.nft; }; then
  install -m 0644 -o root -g root "$nft_tmp" /etc/agentbox/nftables.nft
  log "installed /etc/agentbox/nftables.nft"
  NFT_CHANGED=1
else
  NFT_CHANGED=0
fi
[ -e /etc/agentbox/extra-blocked.conf ] || install -m 0644 /dev/null /etc/agentbox/extra-blocked.conf
install_file etc/systemd/system/agentbox-firewall.service 644; [ "$INSTALLED" = 1 ] && systemctl daemon-reload
systemctl enable agentbox-firewall.service >/dev/null 2>&1
if ! systemctl is-active --quiet agentbox-firewall.service; then
  systemctl start agentbox-firewall.service
elif [ "$NFT_CHANGED" = 1 ]; then
  nft -f /etc/agentbox/nftables.nft
fi
nft list table inet agentbox >/dev/null

# ---- 6.6 AppArmor profile: validation 6.11-C FAILED on this host (rootless podman refuses
# --security-opt apparmor=<profile>: "Apparmor is not enabled on this system"), so the profile is
# NOT installed or loaded by default. Opt in with AGENTBOX_APPARMOR_SANDBOX=1 if a future podman accepts it.
if [ "${AGENTBOX_APPARMOR_SANDBOX:-0}" = 1 ]; then
  install_file etc/apparmor.d/agentbox-sandbox 644
  if [ "$INSTALLED" = 1 ] || ! grep -qs '^agentbox-sandbox ' /sys/kernel/security/apparmor/profiles; then
    apparmor_parser -r /etc/apparmor.d/agentbox-sandbox
    log "loaded AppArmor profile agentbox-sandbox"
  fi
fi

# ---- 6.7 users
make_svc_user() {
  local name="$1" home="$2" range_start="$3"
  if ! id "$name" >/dev/null 2>&1; then
    useradd --system --create-home --home-dir "$home" --shell /usr/sbin/nologin "$name"
    log "created $name"
  fi
  chmod 0700 "$home"
  local end=$((range_start + 65535))
  grep -q "^$name:$range_start:65536$" /etc/subuid || usermod --add-subuids "$range_start-$end" "$name"
  grep -q "^$name:$range_start:65536$" /etc/subgid || usermod --add-subgids "$range_start-$end" "$name"
}
make_svc_user abx-cp /var/lib/agentbox-cp 240000000
make_svc_user abx-build /var/lib/agentbox-build 240065536
[ -e /var/lib/systemd/linger/abx-cp ] || { loginctl enable-linger abx-cp; log "linger on for abx-cp"; }

# Readable names for user@<uid>.service in monitoring tools (Beszel lists system services).
describe_user_manager() {
  local name="$1" desc="$2" dir
  dir="/etc/systemd/system/user@$(id -u "$name").service.d"
  local want="[Unit]"$'\n'"Description=$desc"
  [ "$(cat "$dir/agentbox-description.conf" 2>/dev/null)" = "$want" ] && return 0
  install -d -m 0755 "$dir"
  printf '%s\n' "$want" > "$dir/agentbox-description.conf"
  chmod 0644 "$dir/agentbox-description.conf"
  log "named user@$(id -u "$name").service: $desc"
  RELOAD=1
}
RELOAD=0
describe_user_manager abx-cp "AgentBox control plane (abx-cp)"
describe_user_manager abx-build "AgentBox image builder (abx-build)"
[ "$RELOAD" = 1 ] && systemctl daemon-reload

# ---- 6.8 cgroup delegation
install_file etc/systemd/system/user@.service.d/agentbox-delegate.conf 644; [ "$INSTALLED" = 1 ] && systemctl daemon-reload

# ---- 6.9 patching
install_file etc/apt/apt.conf.d/52agentbox-unattended-upgrades 644
install_file etc/needrestart/conf.d/agentbox.conf 644
systemctl enable unattended-upgrades.service >/dev/null 2>&1 || true

# ---- 6.10 agent install
install_file etc/systemd/system/agentbox-agent.service 644; [ "$INSTALLED" = 1 ] && systemctl daemon-reload
if [ ! -s /etc/agentbox/agent.env ]; then
  umask 077
  printf 'AGENTBOX_AGENT_TOKEN=%s\n' "$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')" > /etc/agentbox/agent.env
  log "generated /etc/agentbox/agent.env"
fi
chown root:root /etc/agentbox/agent.env; chmod 0600 /etc/agentbox/agent.env

AGENT_SRC="$REPO/apps/agent/dist/agent.mjs"
AGENT_CHANGED=0
if [ -f "$AGENT_SRC" ]; then
  if ! cmp -s "$AGENT_SRC" /opt/agentbox/agent/agent.mjs 2>/dev/null; then
    install -D -m 0644 -o root -g root "$AGENT_SRC" /opt/agentbox/agent/agent.mjs
    AGENT_CHANGED=1; log "installed agent bundle"
  fi
else
  log "agent bundle $AGENT_SRC not present: skipping agent install/start"
fi
IMG_SRC="$REPO/images/workspace"
if [ -d "$IMG_SRC" ]; then
  install -d -m 0755 /opt/agentbox/images/workspace
  rsync -a --delete "$IMG_SRC"/ /opt/agentbox/images/workspace/
fi
systemctl enable agentbox-agent.service >/dev/null 2>&1
if [ -f /opt/agentbox/agent/agent.mjs ]; then
  if ! systemctl is-active --quiet agentbox-agent.service; then
    systemctl start agentbox-agent.service
  elif [ "$AGENT_CHANGED" = 1 ]; then
    systemctl restart agentbox-agent.service
  fi
fi

# ---- 6.11 monitoring: Beszel reads containers through the agent's read-only monitor socket
if systemctl cat beszel-agent.service >/dev/null 2>&1; then
  install_file etc/systemd/system/beszel-agent.service.d/agentbox.conf 644
  if [ "$INSTALLED" = 1 ]; then
    systemctl daemon-reload
    systemctl try-restart beszel-agent.service
  fi
fi

cat <<'MSG'

[provision] done. Reminders:
  - run `sudo pro attach <token>` and `sudo pro enable livepatch` (Ubuntu Pro Livepatch)
  - on host shutdown the agent stops all workspaces gracefully (20 s each, parallel); a plain agent restart leaves them running and re-adopts them
MSG
