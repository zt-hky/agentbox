#!/usr/bin/env bash
# AgentBox sandbox security test (docs/security/sandbox.md section J). Run as root:
#   sudo infra/tests/sandbox-security.sh
#
# Provisions throwaway tenants `sectest` (slot 4997) and `secother` (slot 4996) through the host agent's
# unix-socket API, starts both, runs every assertion, prints PASS/FAIL per check and exits non-zero if any
# check FAILed. Both tenants are ALWAYS deleted on exit (EXIT/INT/TERM trap).
#
# Env overrides: IMAGE_ID (default: first 64-hex dir in /srv/agentbox/rootfs), STRICT_UNSHARE=1 (treat a
# successful nested `unshare -Ur` as FAIL even when AppArmor is not applied), AGENT_SOCK.
set -uo pipefail

[ "$(id -u)" -eq 0 ] || { echo "must run as root" >&2; exit 2; }

SOCK="${AGENT_SOCK:-/run/agentbox/agent.sock}"
WS=sectest;  SLOT=4997
OWS=secother; OSLOT=4996
DISK_GB=2 MEM_MB=2048 PIDS=512 CPUS=1
UID_T=$((200000 + SLOT))
OTHER_T3_PORT=$((20000 + 2 * OSLOT))
OTHER_CODE_PORT=$((20001 + 2 * OSLOT))
CT=abx-ws
TOKEN="$(sed -n 's/^AGENTBOX_AGENT_TOKEN=//p' /etc/agentbox/agent.env)"
[ -n "$TOKEN" ] || { echo "no AGENTBOX_AGENT_TOKEN in /etc/agentbox/agent.env" >&2; exit 2; }
IMAGE_ID="${IMAGE_ID:-$(find /srv/agentbox/rootfs -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | grep -E '^[0-9a-f]{64}$' | sort | sed -n 1p)}"
[ -n "$IMAGE_ID" ] || { echo "no image rootfs under /srv/agentbox/rootfs" >&2; exit 2; }
# Fixture secret from the plan (>= 32 bytes base64url); the audience is the workspace slug.
SECRET=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8

PASS=0 FAILS=0
pass() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$1"; }
fail() { FAILS=$((FAILS + 1)); printf 'FAIL  %s%s\n' "$1" "${2:+  ($2)}"; }
info() { printf 'INFO  %s\n' "$1"; }
check() { # check "name" cmd...   -> PASS when cmd exits 0
  local name=$1; shift
  if "$@" >/dev/null 2>&1; then pass "$name"; else fail "$name"; fi
}

api() { # api METHOD PATH [JSON]  -> body on stdout, HTTP status as last line
  local method=$1 path=$2 body=${3:-}
  if [ -n "$body" ]; then
    curl -sS -m 130 --unix-socket "$SOCK" -X "$method" -H "Authorization: Bearer $TOKEN" \
      -H 'content-type: application/json' -d "$body" -w '\n%{http_code}' "http://localhost$path"
  else
    curl -sS -m 130 --unix-socket "$SOCK" -X "$method" -H "Authorization: Bearer $TOKEN" \
      -w '\n%{http_code}' "http://localhost$path"
  fi
}
api_ok() { # api_ok "label" METHOD PATH [JSON] -> sets API_BODY, returns 0 on HTTP 2xx
  local label=$1 out status; shift
  out="$(api "$@")" || { echo "api $label: transport error"; return 1; }
  status="${out##*$'\n'}"; API_BODY="${out%$'\n'*}"
  case "$status" in 2??) return 0 ;; *) echo "api $label: HTTP $status $API_BODY"; return 1 ;; esac
}

# Tenant transport (docs/security/host-validation.md "Agent contract"): run argv in the tenant's user manager.
as_tenant() { local u=$1; shift
  systemd-run "--machine=$u@" --user --quiet --wait --pipe --collect "$@" </dev/null; }
cx() { as_tenant "abx-$WS" podman exec "$CT" "$@"; }             # command inside the sectest container
cxt() { local t=$1; shift; timeout "$t" systemd-run "--machine=abx-$WS@" --user --quiet --wait --pipe --collect \
  podman exec "$CT" "$@" </dev/null; }                             # same, bounded on the host side
escape() { ( cd / && runuser -u "abx-$WS" -- "$@" ); }            # simulated container escape: host shell as the tenant UID

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  echo "--- cleanup: deleting tenants"
  for w in "$WS" "$OWS"; do
    if api_ok "delete $w" DELETE "/v1/tenants/$w" >/dev/null; then echo "deleted $w"; else echo "WARN delete $w failed: $API_BODY"; fi
  done
  if [ "$rc" -ne 0 ] && [ "$FAILS" -eq 0 ]; then FAILS=1; echo "FAIL  aborted before completion (exit $rc)"; fi
  echo "=== $PASS passed, $FAILS failed"
  [ "$FAILS" -eq 0 ] && exit 0 || exit 1
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

limits_json="{\"cpus\":$CPUS,\"memoryMb\":$MEM_MB,\"pidsLimit\":$PIDS}"
provision() { # provision ws slot -> create + start; echo cgroupPath to PROV_CG
  local w=$1 s=$2
  api_ok "create $w" POST /v1/tenants "{\"ws\":\"$w\",\"slot\":$s,\"diskGb\":$DISK_GB,\"limits\":$limits_json}" || return 1
  api_ok "start $w" POST "/v1/workspaces/$w/start" \
    "{\"imageId\":\"$IMAGE_ID\",\"slot\":$s,\"limits\":$limits_json,\"env\":{\"T3CODE_GATEWAY_IDENTITY_SECRET\":\"$SECRET\",\"T3CODE_GATEWAY_IDENTITY_AUDIENCE\":\"$w\"}}" || return 1
  PROV_CG="$(printf '%s' "$API_BODY" | python3 -c 'import json,sys; print(json.load(sys.stdin)["cgroupPath"])')"
}

echo "=== AgentBox sandbox security test  image=$IMAGE_ID"
echo "--- provisioning $WS (slot $SLOT, uid $UID_T) and $OWS (slot $OSLOT)"
provision "$WS" "$SLOT" || { fail "provision $WS"; exit 1; }
CG="/sys/fs/cgroup$PROV_CG"
[ -d "$CG" ] || { fail "cgroup dir $CG exists"; exit 1; }
provision "$OWS" "$OSLOT" || { fail "provision $OWS"; exit 1; }
pass "provision $WS + $OWS and start both (health on both ports)"

# ---------------------------------------------------------------- network
echo "--- network egress (inside the sandbox, tenant uid $UID_T)"
nft_ctr() { nft list chain inet agentbox output | sed -n "s/.*$1.*counter packets \([0-9]*\).*/\1/p" | sed -n 1p; }
BLK0=$(nft_ctr '@blocked4'); SMTP0=$(nft_ctr 'tcp dport 25'); V60=$(nft_ctr 'nfproto ipv6')

code=$(cx curl -s -m 10 -o /dev/null -w '%{http_code}' https://example.com 2>&1 || true)
[ "$code" = 200 ] && pass "internet: https://example.com -> 200" || fail "internet: https://example.com" "got '$code'"

tcp_blocked() { # tcp_blocked host port : connect must fail inside the sandbox; bash+timeout exist in the image
  cxt 8 timeout 3 bash -c "exec 3<>/dev/tcp/$1/$2"
  [ $? -ne 0 ]
}
check "positive control: tcp 1.1.1.1:443 connects" cxt 10 timeout 5 bash -c 'exec 3<>/dev/tcp/1.1.1.1/443'
for target in 192.168.124.1:80 192.168.124.10:22 10.0.0.1:80 172.17.0.1:80 192.168.1.1:80 \
              100.80.0.1:22 100.96.0.10:80 169.254.169.254:80 1.1.1.1:25; do
  check "blocked: ${target}" tcp_blocked "${target%:*}" "${target#*:}"
done
code=$(cx curl -s -m 4 -o /dev/null -w '%{http_code}' http://169.254.169.254/latest/meta-data/ 2>&1 || true)
[ "$code" = 000 ] && pass "metadata: curl http://169.254.169.254 -> no response" || fail "metadata curl" "got '$code'"
for p in 22 3000 3001 5432 "$OTHER_T3_PORT" "$OTHER_CODE_PORT"; do
  check "loopback 127.0.0.1:$p not reachable from sandbox" tcp_blocked 127.0.0.1 "$p"
done
if cx curl -6 -s -m 5 -o /dev/null https://example.com >/dev/null 2>&1; then fail "ipv6: curl -6 must fail"; else pass "ipv6: curl -6 fails"; fi
sleep 1
BLK1=$(nft_ctr '@blocked4'); SMTP1=$(nft_ctr 'tcp dport 25'); V61=$(nft_ctr 'nfproto ipv6')
[ "${BLK1:-0}" -gt "${BLK0:-0}" ] && pass "nft: @blocked4 counter incremented ($BLK0 -> $BLK1)" || fail "nft: @blocked4 counter" "$BLK0 -> $BLK1"
[ "${SMTP1:-0}" -gt "${SMTP0:-0}" ] && pass "nft: tcp dport 25 counter incremented ($SMTP0 -> $SMTP1)" || fail "nft: smtp counter" "$SMTP0 -> $SMTP1"
info "nft: ipv6 drop counter $V60 -> $V61 (informational; pasta runs --ipv4-only)"

# ---------------------------------------------------------------- privileges
echo "--- privileges inside the sandbox"
[ "$(cx id -u 2>&1)" = 1000 ] && pass "id -u == 1000" || fail "id -u == 1000"
st=$(cx cat /proc/self/status 2>&1)
grep -q '^CapEff:[[:space:]]*0000000000000000$' <<<"$st" && pass "CapEff == 0" || fail "CapEff == 0" "$(grep '^CapEff' <<<"$st")"
grep -q '^CapBnd:[[:space:]]*0000000000000000$' <<<"$st" && pass "CapBnd == 0 (cap-drop=ALL)" || fail "CapBnd == 0" "$(grep '^CapBnd' <<<"$st")"
grep -q '^NoNewPrivs:[[:space:]]*1$' <<<"$st" && pass "NoNewPrivs == 1" || fail "NoNewPrivs == 1"
grep -q '^Seccomp:[[:space:]]*2$' <<<"$st" && pass "Seccomp == 2 (default filter)" || fail "Seccomp == 2"
if cx sh -c 'echo x > /etc/x' >/dev/null 2>&1; then fail "write /etc/x must fail (read-only rootfs)"; else pass "write /etc/x fails"; fi
if cx sh -c 'echo x > /usr/x' >/dev/null 2>&1; then fail "write /usr/x must fail"; else pass "write /usr/x fails"; fi
check "write /workspace works" cx sh -c 'echo ok > /workspace/.sectest-w && rm /workspace/.sectest-w'
check "write /tmp works" cx sh -c 'echo ok > /tmp/.sectest-t && rm /tmp/.sectest-t'
aa=$(cx cat /proc/1/attr/current 2>&1 || true)
if cx unshare -Ur true >/dev/null 2>&1; then
  if [ "$aa" = agentbox-sandbox ] || [ "${STRICT_UNSHARE:-0}" = 1 ]; then
    fail "unshare -Ur true must fail" "AppArmor attr: $aa"
  else
    info "KNOWN RISK #4: unshare -Ur succeeds; AppArmor not applied to rootless sandboxes (/proc/1/attr/current='$aa'), see docs/security/sandbox.md B/G"
    pass "unshare -Ur true: known residual risk recorded (not a regression)"
  fi
else
  pass "unshare -Ur true fails"
fi

# ---------------------------------------------------------------- simulated escape
echo "--- simulated escape: host shell as abx-$WS (uid $UID_T)"
denied() { # denied "name" cmd... : must fail with Permission denied
  local name=$1 out; shift
  out=$(escape "$@" 2>&1); local rc=$?
  if [ $rc -ne 0 ] && grep -qi 'permission denied' <<<"$out"; then pass "escape: $name -> permission denied"
  else fail "escape: $name" "rc=$rc out='$(head -c 120 <<<"$out")'"; fi
}
[ "$(escape id -u)" = "$UID_T" ] && pass "escape shell runs as uid $UID_T" || fail "escape shell uid"
denied "cat /home/kyle/.ssh/known_hosts" cat /home/kyle/.ssh/known_hosts
denied "ls /var/lib/agentbox-cp" ls /var/lib/agentbox-cp
denied "ls /srv/agentbox/tenants/$OWS" ls "/srv/agentbox/tenants/$OWS"
denied "cat /etc/agentbox/agent.env" cat /etc/agentbox/agent.env
if escape curl -sS -m 3 --unix-socket "$SOCK" -H "Authorization: Bearer $TOKEN" http://localhost/v1/stats >/dev/null 2>&1; then
  fail "escape: agent socket must be unreachable"
else
  pass "escape: agent socket unreachable (0600 abx-cp)"
fi
if escape sudo -n true >/dev/null 2>&1; then fail "escape: sudo -n true must fail"; else pass "escape: sudo -n true fails"; fi
# Positive controls (as root) prove the targets are listening, so the tenant failures come from nftables.
root_code() { curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$1/" 2>/dev/null; }
for p in 3000 3001 "$OTHER_T3_PORT" "$OTHER_CODE_PORT"; do
  rc=$(root_code "$p")
  if [ "$rc" = 000 ]; then fail "control: root reaches 127.0.0.1:$p" "no listener"; continue; fi
  c=$(escape curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$p/" 2>&1 || true)
  [ "$c" = 000 ] && pass "escape: curl 127.0.0.1:$p blocked (root got $rc)" || fail "escape: curl 127.0.0.1:$p" "tenant got '$c'"
done
c=$(escape curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:5432/ 2>&1 || true)
[ "$c" = 000 ] && pass "escape: curl 127.0.0.1:5432 fails" || fail "escape: curl 127.0.0.1:5432" "got '$c'"
c=$(escape curl -s -m 3 -o /dev/null -w '%{http_code}' http://100.80.0.1:22/ 2>&1 || true)
[ "$c" = 000 ] && pass "escape: curl 100.80.0.1:22 blocked" || fail "escape: curl 100.80.0.1:22" "got '$c'"

# ---------------------------------------------------------------- resource bombs
restart_ct() { # stop + start through the agent API, the same path the worker uses; refreshes CG
  api_ok "stop $WS" POST "/v1/workspaces/$WS/stop" >/dev/null || true
  if api_ok "start $WS" POST "/v1/workspaces/$WS/start" \
    "{\"imageId\":\"$IMAGE_ID\",\"slot\":$SLOT,\"limits\":$limits_json,\"env\":{\"T3CODE_GATEWAY_IDENTITY_SECRET\":\"$SECRET\",\"T3CODE_GATEWAY_IDENTITY_AUDIENCE\":\"$WS\"}}"; then
    PROV_CG="$(printf '%s' "$API_BODY" | python3 -c 'import json,sys; print(json.load(sys.stdin)["cgroupPath"])')"
    CG="/sys/fs/cgroup$PROV_CG"
  else
    fail "restart $WS via agent" "$API_BODY"
  fi
}
memavail_kb() { awk '/^MemAvailable:/ {print $2}' /proc/meminfo; }
oom_kills() { awk '/^oom_kill /{print $2}' "$CG/memory.events" 2>/dev/null; }

echo "--- memory bomb (limit ${MEM_MB} MiB, swap == memory)"
O0=$(oom_kills)
# `podman exec` starts at the user manager's oom_score_adj (200); processes users start from T3 or the
# terminal inherit the container's 1000, so raise the bomb to match what a real runaway job would have.
cx bash -c 'echo 1000 > /proc/self/oom_score_adj && exec python3 -c "
b = []
while True:
    b.append(b\"x\" * (64 << 20))"' >/dev/null 2>&1
rc=$?
O1=$(oom_kills)
[ "$rc" -ne 0 ] && pass "memory bomb killed (exit $rc)" || fail "memory bomb must be killed"
[ "${O1:-0}" -gt "${O0:-0}" ] && pass "memory.events oom_kill incremented ($O0 -> $O1)" || fail "oom_kill incremented" "$O0 -> $O1"
as_tenant "abx-$WS" podman ps --filter "name=^$CT\$" --format '{{.State}}' 2>/dev/null | grep -q running &&
  pass "workspace container survived the memory bomb" || fail "workspace container survived the memory bomb"
MA=$(memavail_kb)
[ "${MA:-0}" -gt $((4 * 1024 * 1024)) ] && pass "host MemAvailable ${MA} kB > 4 GiB" || fail "host MemAvailable > 4 GiB" "${MA} kB"
MCUR=$(cat "$CG/memory.current"); MMAX=$(cat "$CG/memory.max")
info "memory.current=$MCUR memory.max=$MMAX"

echo "--- disk quota (bhard ${DISK_GB} GiB, ihard 4000000)"
cx rm -f /workspace/fill /workspace/fill2 >/dev/null 2>&1
out=$(cxt 120 dd if=/dev/zero of=/workspace/fill bs=1M count=$((DISK_GB * 1024 + 512)) oflag=direct 2>&1); rc=$?
sz=$(cx stat -c %s /workspace/fill 2>/dev/null || echo 0)
{ [ "$rc" -ne 0 ] && grep -q 'Disk quota exceeded' <<<"$out"; } && pass "dd oflag=direct fails with 'Disk quota exceeded'" || fail "dd oflag=direct quota" "rc=$rc out='$(tail -c 150 <<<"$out")'"
LIM=$((DISK_GB * 1024 * 1024 * 1024))
{ [ "$sz" -le "$LIM" ] && [ "$sz" -ge $((LIM * 90 / 100)) ]; } && pass "file stopped near quota ($sz of $LIM bytes)" || fail "file size near quota" "$sz of $LIM"
cx rm -f /workspace/fill >/dev/null 2>&1
# Observed in host-validation G: buffered writers can be killed by the memory cgroup (page cache on the loop-backed
# XFS) before the quota triggers. Informational only: either outcome is acceptable, but the host must stay healthy.
out=$(cxt 150 dd if=/dev/zero of=/workspace/fill2 bs=1M count=$((DISK_GB * 1024 + 512)) 2>&1); rc=$?
sz=$(cx stat -c %s /workspace/fill2 2>/dev/null || echo 0)
if grep -q 'Disk quota exceeded' <<<"$out"; then b="quota hit"; else b="no quota message (rc=$rc, likely killed by the memory limit)"; fi
info "buffered dd: $b; file $sz bytes, oom_kill now $(oom_kills)"
cx rm -f /workspace/fill2 >/dev/null 2>&1
[ "$(memavail_kb)" -gt $((4 * 1024 * 1024)) ] && pass "host MemAvailable > 4 GiB after buffered dd" || fail "host MemAvailable after buffered dd"
if ! as_tenant "abx-$WS" podman ps --filter "name=^$CT\$" --format '{{.State}}' 2>/dev/null | grep -q running; then restart_ct; fi

echo "--- fork bomb (pids limit $PIDS)"
restart_ct
as_tenant "abx-$WS" podman exec -d "$CT" bash -c ':(){ :|:& };:' >/dev/null 2>&1
maxp=0 slow=0
for _ in $(seq 1 12); do
  sleep 0.5
  p=$(cat "$CG/pids.current" 2>/dev/null || echo 0)
  [ "$p" -gt "$maxp" ] && maxp=$p
  s=$(date +%s%N)
  timeout 2 systemctl is-system-running >/dev/null 2>&1; trc=$?
  e=$(( ($(date +%s%N) - s) / 1000000 ))
  { [ "$trc" -eq 124 ] || [ "$e" -ge 2000 ]; } && slow=$((slow + 1))
done
[ "$maxp" -gt 100 ] && pass "fork bomb actually ran (peak pids.current=$maxp)" || fail "fork bomb ran" "peak $maxp"
[ "$maxp" -le "$PIDS" ] && pass "pids.current peak $maxp <= pidsLimit $PIDS" || fail "pids.current <= $PIDS" "peak $maxp"
[ "$slow" -eq 0 ] && pass "systemctl is-system-running answered within 2 s on all 12 samples" || fail "systemctl is-system-running within 2 s" "$slow slow samples"
restart_ct
pc=$(cat "$CG/pids.current" 2>/dev/null || echo 0)
[ "$pc" -lt 200 ] && pass "container recovered after bomb (pids.current=$pc)" || fail "container recovered" "pids.current=$pc"

[ "$FAILS" -eq 0 ] && echo "ALL CHECKS PASSED" || echo "$FAILS CHECK(S) FAILED"
exit 0
