# Shared helpers for secrets.sh and deploy.sh (sourced, root).
CP_USER=abx-cp
CP_HOME=/var/lib/agentbox-cp
QUADLET_DIR=$CP_HOME/.config/containers/systemd

[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 1; }

# Run a command as abx-cp inside its user manager (same transport as docs/security/host-validation.md).
abxcp() {
  systemd-run --machine="$CP_USER@" --user --quiet --wait --pipe --collect "$@"
}
abxcp_ctl() { systemctl --user -M "$CP_USER@" "$@"; }

# user@<uid> must be up (linger keeps it, but be explicit).
ensure_cp_manager() {
  systemctl start "user@$(id -u "$CP_USER").service"
}

secret_exists() { abxcp podman secret inspect "$1" >/dev/null 2>&1; }
