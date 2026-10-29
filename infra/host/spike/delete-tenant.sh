#!/usr/bin/env bash
# Mirrors agent DELETE /v1/tenants/:ws. Usage: sudo delete-tenant.sh <ws> <slot>
set -uo pipefail
ws=$1 slot=$2
U=$((200000 + slot)); S=$((300000000 + slot * 65536)); H=/srv/agentbox/tenants/$ws
runuser -u "abx-$ws" -- env XDG_RUNTIME_DIR=/run/user/$U podman rm -f abx-ws >/dev/null 2>&1
loginctl disable-linger "abx-$ws" 2>/dev/null
systemctl stop "user@$U.service"
xfs_quota -x -c "limit -u bsoft=0 bhard=0 ihard=0 $U" /srv/agentbox
usermod --del-subuids "$S-$((S+65535))" --del-subgids "$S-$((S+65535))" "abx-$ws"
userdel "abx-$ws"
rm -rf --one-file-system "$H"
rm -rf "/etc/systemd/system/user@$U.service.d" "/etc/systemd/system/user-$U.slice.d"
systemctl daemon-reload
