#!/usr/bin/env bash
# Run the full step-7 `podman run` for the spike tenant (slot 4999) as that tenant. Extra args after `--` are the container command.
# Env: APPARMOR=0 to drop apparmor, NETWORK override, ROOTFS override, EXTRA="..." extra podman flags, TRANSPORT=systemd|runuser
set -euo pipefail
ws=spike slot=4999; U=204999
ROOTFS=${ROOTFS:-/srv/agentbox/rootfs/spike}
NETWORK=${NETWORK:-pasta:--no-map-gw,--ipv4-only,--map-guest-addr,none}
H=/srv/agentbox/tenants/$ws
if [ "${TRANSPORT:-systemd}" = systemd ]; then
  T=(systemd-run --machine=abx-$ws@ --user --quiet --wait --pipe --collect ${SDRUN_EXTRA:-})
else
  T=(runuser -u abx-$ws -- env XDG_RUNTIME_DIR=/run/user/$U DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$U/bus)
fi
printf 'T3CODE_GATEWAY_IDENTITY_SECRET=x\nT3CODE_GATEWAY_IDENTITY_AUDIENCE=spike\n' | "${T[@]}" sh -c 'umask 077; cat > "$1"' sh $H/t3.env
AA=(); [ "${APPARMOR:-1}" = 1 ] && AA=(--security-opt=apparmor=agentbox-sandbox)
exec "${T[@]}" podman run ${RM---rm} --name abx-ws --hostname $ws \
  --rootfs --read-only \
  --userns=keep-id:uid=1000,gid=1000 --user 1000:1000 \
  --cap-drop=ALL --security-opt=no-new-privileges "${AA[@]}" \
  --network "$NETWORK" --dns 1.1.1.1 --dns 1.0.0.1 \
  -p 127.0.0.1:$((20000+2*slot)):3773 -p 127.0.0.1:$((20001+2*slot)):8080 \
  --memory ${MEM:-512}m --memory-swap ${MEM:-512}m --oom-score-adj 1000 --cpus 1 \
  --pids-limit 256 --ulimit nproc=512:512 --ulimit nofile=65536:65536 --ulimit core=0 \
  --tmpfs /tmp:rw,nosuid,nodev,size=2g,mode=1777 --tmpfs /var/tmp:rw,nosuid,nodev,size=512m,mode=1777 \
  --tmpfs /run:rw,nosuid,nodev,size=64m --shm-size 256m \
  -v $H/workspace:/workspace:rw,nosuid,nodev \
  --workdir /workspace --env HOME=/workspace/home --env-file $H/t3.env \
  --log-driver k8s-file --log-opt max-size=10mb --init --stop-timeout 20 \
  --label agentbox.workspace=$ws ${EXTRA:-} \
  "$ROOTFS" "$@"
