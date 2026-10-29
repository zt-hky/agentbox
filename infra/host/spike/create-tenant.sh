#!/usr/bin/env bash
# Throwaway tenant creation by hand (mirrors agent POST /v1/tenants). Usage: sudo create-tenant.sh <ws> <slot> <diskGb>
# NOTE: `useradd --user-group --uid U` alone picks GID 1001+, not U; create the group with an explicit GID first.
set -euo pipefail
ws=$1 slot=$2 gb=$3
U=$((200000 + slot)); S=$((300000000 + slot * 65536)); H=/srv/agentbox/tenants/$ws
groupadd --gid "$U" "abx-$ws"
useradd --uid "$U" --gid "$U" --home-dir "$H" --create-home --skel /dev/null --shell /usr/sbin/nologin "abx-$ws"
passwd -l "abx-$ws" >/dev/null
usermod --add-subuids "$S-$((S+65535))" --add-subgids "$S-$((S+65535))" "abx-$ws"
chmod 0700 "$H"
install -d -m 0700 -o "$U" -g "$U" "$H/workspace"
xfs_quota -x -c "limit -u bsoft=$((gb*1024*95/100))m bhard=${gb}g ihard=4000000 $U" /srv/agentbox
