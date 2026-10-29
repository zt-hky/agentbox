#!/bin/bash
set -uo pipefail
MNT=/srv/agentbox
mountpoint -q "$MNT" && umount "$MNT"
if [ -f /run/agentbox-loopdev ]; then
  losetup -d "$(cat /run/agentbox-loopdev)" || true
  rm -f /run/agentbox-loopdev
fi
exit 0
