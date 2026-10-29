#!/bin/bash
set -euo pipefail
IMG=/var/lib/agentbox/tenants.xfs
MNT=/srv/agentbox
mkdir -p "$MNT"
if mountpoint -q "$MNT"; then exit 0; fi
dev=$(losetup --direct-io=on --show -f "$IMG")
echo "$dev" > /run/agentbox-loopdev
mount -o uquota,noatime,nosuid,nodev "$dev" "$MNT"
