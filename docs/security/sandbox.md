# AgentBox sandbox security

Rootless Podman only: no gVisor, Kata, Firecracker or VM. The design assumes a container escape lands as the
tenant's host UID (`200000 + slot`) and that this must still not reach root, other tenants, control-plane
secrets, private networks or the host. The shared host kernel stays the residual risk.

Sections D, E, F, G and H quote the files actually used; everything else points at the files in `infra/` and
`apps/agent/` instead of duplicating them. Where this document and `host-validation.md` ("Agent contract")
differ from the original plan, the validated behaviour is what is written here.

## A. Architecture

```
Internet
  |
Cloudflare edge (TLS, *.agentbox.io.vn)
  |  tunnel
cloudflared                         [abx-cp, rootless, Network=host]      infra/cp/quadlet/agentbox-cloudflared.container
  |  http://127.0.0.1:8480
Caddy :8480                         [abx-cp, Network=host]                infra/cp/Caddyfile
  |-- app.<D>          ----------> web :3000 ----+
  |-- <ws>-<svc>.<D>:                            |   pod agentbox-cp (abx-cp), published on 127.0.0.1 only
  |     forward_auth -> gateway-auth :3001 ------+   web, worker (3001), postgres (pod-internal only)
  |     reverse_proxy -> 127.0.0.1:<20000+2n | 20001+2n>
  |
  |   worker --/run/agentbox/agent.sock (0600 abx-cp)--> agent (root, Node 22)   apps/agent
  |                                                          |
  |                                      systemd-run --machine=abx-<ws>@ --user ...
  |                                                          |
  v                                              user@<U>.service (per tenant, lingering)
pasta (tenant UID U, owns the published port) <--> rootless Podman container abx-ws
                                                   (uid 1000 in a keep-id user namespace, T3 :3773, code-server :8080)

Egress: every packet leaving a sandbox is sent by the tenant's pasta process (UID U); an escaped process is also
UID U. nftables `inet agentbox` `output` chain matches `meta skuid 200001-204999` (section E).
```

- Tenant UID/GID `200000 + slot`, subuid/subgid `300000000 + slot*65536` (65536 IDs), home
  `/srv/agentbox/tenants/<ws>` (0700, XFS with user quota on a loop file), shell `nologin`, password locked,
  not in `sudo`, slots never reused.
- Workspace hosts are one label under the base domain, so workspaces do not share an origin with each other or
  with the control plane. The gateway strips `__Host-abx_ws` before proxying (`infra/cp/Caddyfile`).
- The agent socket is only bind-mounted into the worker container, not the web container.

## B. Threat model and ranked residual risks

Assets: other tenants' workspaces and data, control-plane secrets (Postgres, `AGENTBOX_AGENT_TOKEN`, OAuth and
encryption keys, Cloudflare tunnel token), the root agent, the host's other services, private and VPN networks.
Attacker: an authenticated tenant with arbitrary code execution inside their container, assuming they escape to
the host as their tenant UID.

Ranked residual risks:

1. **Shared host kernel LPE.** Escape plus a kernel bug gives root. Mitigations: default seccomp filter,
   `--cap-drop=ALL`, `no-new-privileges`, the sysctl set in F, the module blacklist
   (`infra/host/files/etc/modprobe.d/agentbox-blacklist.conf`), unattended security upgrades with kernel
   auto-reboot at 04:00, Ubuntu Pro Livepatch (reminder printed by `provision.sh`, not yet attached).
2. **Control plane and the operator's personal services share this host** (`~/.t3`, `~/.omp`, SSH keys,
   Tailscale, WARP, the personal Cloudflare tunnel). Separation relies on UIDs, 0700 home directories, the
   `InaccessiblePaths=-/home -/root` user-manager drop-in (replaces the planned `ProtectHome=yes`, see H) and
   nftables. **Move sandboxes to a dedicated host for production**; the agent is the only component that has to
   move (the worker already talks to it over a socket).
3. **Abstract unix sockets in the init network namespace** are reachable by an escaped process (they ignore
   filesystem permissions). Anything sensitive listening on an abstract socket on the host is exposed.
4. **AppArmor is not applied to rootless sandboxes (ACTIVE).** Host validation C: rootless Podman treats
   AppArmor as disabled and rejects `--security-opt=apparmor=agentbox-sandbox` ("specified, but Apparmor is not
   enabled on this system") even with the profile loaded. The option was dropped and
   `/proc/1/attr/current` inside the container is `crun (unconfined)`. Consequences: the `deny mount/userns/
/proc/sys/...` rules in G do not apply; a nested `unshare -Ur true` inside the container succeeds.
   Compensating controls: seccomp default filter, CapBnd/CapEff 0, `no-new-privileges`, read-only rootfs,
   `kernel.apparmor_restrict_unprivileged_userns=1` on the host (confines unprivileged user namespaces created
   by unconfined processes outside the container), egress filtering. `provision.sh` no longer loads the
   profile unless `AGENTBOX_APPARMOR_SANDBOX=1`.
5. **`/proc` information about other UIDs after escape.** `hidepid` is not used (it breaks logind/polkit).
6. **Loop-device XFS layer.** Tenant data sits in an XFS image on a loop device (`losetup --direct-io=on`); a
   filesystem or loop driver bug is reachable from tenant file operations. Quota enforcement is per user
   (`uquota`), not per project.
7. **Supply chain of the `latest` CLIs** (Codex, Claude Code, Oh My Pi, code-server, T3 fork) baked into the
   image. Mitigations: Trivy scan per build and admin activation before an image is used.

Other validated deviations that affect the model:

- **Tenants linger** (`loginctl enable-linger abx-<ws>`): without it logind stops `user@U` when the last
  `systemd-run --machine` session closes and the container dies. Each provisioned tenant keeps a user manager
  entry (~10 MB RAM only while running; the agent stops `user@U.service` when the workspace is stopped).
- **`KillMode=process`** (`systemd-run -p KillMode=process`) for the detached `podman run -d`: otherwise systemd
  kills conmon when the transient `run-*.service` finishes and the container exits with 143.
- **`ProtectKernelLogs=yes` was dropped** from the user drop-in (container start fails: `crun: mount proc to
proc: Operation not permitted`); `ProtectHome=yes` was replaced by `InaccessiblePaths=-/home -/root` (the user
  manager cannot start with it, it hides `/run/user`).
- Shared root-owned `--rootfs` works only if the exported rootfs already contains `/etc/mtab ->
../proc/self/mounts`, empty `/workspace`, `/tmp`, `/var/tmp`, `/run`, `/etc/{hosts,hostname,resolv.conf}` and
  no `/run/.containerenv`.
- `/etc/resolv.conf` in the sandbox may carry the host's `search` line (minor information leak).

## C. Production checklist

Status is from `host-validation.md` and the files in `infra/`; `[ ]` means not done or not verified.

- [x] Packages installed (`podman passt uidmap catatonit xfsprogs nftables acl nodejs unattended-upgrades needrestart`), `infra/host/provision.sh` idempotent (second run is a no-op)
- [x] Tenant XFS storage at `/srv/agentbox` (`agentbox-storage.service`, `uquota,noatime,nosuid,nodev`, loop with direct I/O); `tenants` 0711, `rootfs` 0755
- [x] `/etc/sysctl.d/99-agentbox-hardening.conf` applied (F); `io_uring_disabled=2` broke nothing on this host
- [x] `/etc/modprobe.d/agentbox-blacklist.conf`
- [x] `agentbox-firewall.service` loading `/etc/agentbox/nftables.nft` atomically (E); no `flush ruleset`; unrelated tables untouched
- [ ] AppArmor profile `agentbox-sandbox` **not** loaded or applied (G, residual risk 4); re-test with newer podman and set `AGENTBOX_APPARMOR_SANDBOX=1` only if `apparmor=agentbox-sandbox` is accepted
- [x] `abx-cp` (subuid 240000000) with linger, `abx-build` (240065536) without; neither in sudo, homes 0700
- [x] `/etc/systemd/system/user@.service.d/agentbox-delegate.conf`: `Delegate=cpu cpuset io memory pids`
- [x] unattended-upgrades (security pocket, auto-reboot 04:00) and needrestart auto-restart config installed
- [ ] Ubuntu Pro Livepatch attached (`pro attach`, `pro enable livepatch`): manual step
- [x] `/etc/agentbox/agent.env` root 0600; `agentbox-agent.service` active, socket `/run/agentbox/agent.sock` owned by `abx-cp`, 0600
- [x] Per-tenant user@ and slice drop-ins written by the agent (H), `systemctl daemon-reload`, linger enabled
- [x] Control plane deployed as `abx-cp` (`infra/cp/deploy.sh`): Caddy `127.0.0.1:8480`, web 3000, worker 3001, Postgres pod-internal
- [x] Host validation A (transport), B (shared rootfs), D (pasta), E (drop-ins, with fallback), F (egress), G (quota): PASS; C (AppArmor): FAIL, fallback applied
- [ ] `sudo infra/tests/sandbox-security.sh` run to completion on the production host after every change to D/E/F/H (section J)
- [ ] Image scanned with Trivy and activated by an admin before first use
- [ ] Sandboxes moved to a dedicated host (residual risk 2)

## D. The `podman run` (from `apps/agent/src/argv.ts`, `podmanRunArgv`)

The agent runs it as the tenant through the transport prefix from `transportPrefix(user, { detached: true })`, as
root via `execFile` (no shell):

```
systemd-run --machine=abx-<ws>@ --user --quiet --wait --pipe --collect -p KillMode=process
```

then the container argv (`<t3> = 20000 + 2*slot`, `<code> = 20001 + 2*slot`, `<M>` = `memoryMb`, `<P>` =
`pidsLimit`, `<C>` = `cpus`):

```
podman run -d --replace --name abx-ws --hostname <ws> --rootfs --read-only
  --userns=keep-id:uid=1000,gid=1000 --user 1000:1000
  --cap-drop=ALL --security-opt=no-new-privileges
  --network pasta:--no-map-gw,--ipv4-only,--map-guest-addr,none --dns 1.1.1.1 --dns 1.0.0.1
  -p 127.0.0.1:<t3>:3773 -p 127.0.0.1:<code>:8080
  --memory <M>m --memory-swap <M>m --oom-score-adj 1000 --cpus <C>
  --pids-limit <P> --ulimit nproc=<P+256>:<P+256> --ulimit nofile=65536:65536 --ulimit core=0
  --tmpfs /tmp:rw,nosuid,nodev,size=2g,mode=1777 --tmpfs /var/tmp:rw,nosuid,nodev,size=512m,mode=1777
  --tmpfs /run:rw,nosuid,nodev,size=64m --shm-size 256m
  -v /srv/agentbox/tenants/<ws>/workspace:/workspace:rw,nosuid,nodev
  --workdir /workspace --env HOME=/workspace/home --env-file /srv/agentbox/tenants/<ws>/t3.env
  --log-driver k8s-file --log-opt max-size=10mb --init --stop-timeout 20
  --label agentbox.workspace=<ws>
  /srv/agentbox/rootfs/<imageId> /opt/agentbox/bin/workspace-init
```

Differences from the original plan: `--rootfs` is a boolean flag and the rootfs directory is the positional image
argument; **`--security-opt=apparmor=agentbox-sandbox` is removed** (C / B risk 4); `t3.env` is written by the
tenant (`umask 077; cat > file && chmod 600`, `writeSecretFileArgv`) and holds only the two gateway-identity
variables.

## E. nftables (`/etc/agentbox/nftables.nft`, identical to `infra/host/files/etc/agentbox/nftables.nft`)

```
# AgentBox egress firewall for tenant UIDs 200001-204999. Loaded atomically; never flushes the ruleset.
table inet agentbox {}
delete table inet agentbox

table inet agentbox {
  set blocked4 { type ipv4_addr; flags interval; auto-merge;
    elements = { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16,
                 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24, 192.88.99.0/24, 192.168.0.0/16,
                 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/3 } }
  set extra_blocked4 { type ipv4_addr; flags interval; auto-merge; }
  set newconn_rate { type uid; flags dynamic, timeout; timeout 10s; }
  chain output {
    type filter hook output priority filter - 5; policy accept;
    meta skuid != 200001-204999 accept
    ct state established,related accept
    meta nfproto ipv6 counter drop
    ip daddr @blocked4 counter drop
    ip daddr @extra_blocked4 counter drop
    tcp dport 25 counter drop
    ct state new update @newconn_rate { meta skuid limit rate over 200/second burst 400 packets } counter drop
    accept
  }
}
```

Notes: `established,related` lets pasta answer Caddy's inbound connections to the published loopback ports.
`127.0.0.0/8`, `100.64.0.0/10` (Tailscale/CGNAT, includes 100.80.0.1 and 100.96.0.10), `169.254.0.0/16`
(metadata) and RFC1918 are all in `blocked4`. `extra_blocked4` holds the host's public egress IPv4 and admin CIDRs
from `/etc/agentbox/extra-blocked.conf`, maintained by the agent (`apps/agent/src/firewall.ts`, sync every 10
min). Load/unload: `agentbox-firewall.service` (`infra/host/files/etc/systemd/system/agentbox-firewall.service`),
`ExecStop=nft delete table inet agentbox`. Observed counters after host validation: `@blocked4` 45 -> 91,
`tcp dport 25` 0 -> 4, `nfproto ipv6` 2783 -> 2817.

## F. sysctl (`/etc/sysctl.d/99-agentbox-hardening.conf`, identical to `infra/host/files/etc/sysctl.d/`)

```
# AgentBox host hardening (installed by infra/host/provision.sh)
kernel.kptr_restrict = 2
kernel.dmesg_restrict = 1
kernel.unprivileged_bpf_disabled = 1
net.core.bpf_jit_harden = 2
kernel.perf_event_paranoid = 4
# ptrace_scope 1: 2/3 break gdb/strace
kernel.yama.ptrace_scope = 1
kernel.kexec_load_disabled = 1
kernel.sysrq = 0
kernel.io_uring_disabled = 2
vm.unprivileged_userfaultfd = 0
fs.protected_hardlinks = 1
fs.protected_symlinks = 1
fs.protected_fifos = 2
fs.protected_regular = 2
fs.suid_dumpable = 0
dev.tty.ldisc_autoload = 0
# Works because /etc/apparmor.d/podman grants `userns` to podman and denies nested userns in sandboxes.
kernel.apparmor_restrict_unprivileged_userns = 1
# Deliberately NOT set: user.max_user_namespaces=0, kernel.unprivileged_userns_clone=0,
# ptrace_scope=3, kernel.modules_disabled=1.
```

Notes: `ptrace_scope` 1 because 2/3 break gdb/strace. `io_uring_disabled=2` is safe here: libuv falls back, and
`node`, `/usr/bin/node`, `podman ps`, `omp`, `bun` all kept working after it was applied. The AppArmor userns
restriction works for podman because `/etc/apparmor.d/podman` grants `userns`; note that it does **not** restrict
processes inside an already-unconfined container (risk 4). Never set `user.max_user_namespaces=0`,
`kernel.unprivileged_userns_clone=0`, `ptrace_scope=3` or `kernel.modules_disabled=1`: rootless Podman needs user
namespaces.

## G. AppArmor profile (`infra/host/files/etc/apparmor.d/agentbox-sandbox`) — NOT APPLIED

```
# AgentBox rootless sandbox profile (deny rules only, not audit-logged).
abi <abi/4.0>,
include <tunables/global>

profile agentbox-sandbox flags=(attach_disconnected,mediate_deleted) {
  include <abstractions/base>

  network,
  file,
  capability,
  signal peer=agentbox-sandbox,
  ptrace peer=agentbox-sandbox,

  deny mount,
  deny umount,
  deny pivot_root,
  deny userns,
  deny @{PROC}/sys/** wklx,
  deny @{PROC}/sysrq-trigger rwklx,
  deny @{PROC}/kcore rwklx,
  deny /sys/kernel/{security,debug}/** rwklx,
  deny /sys/firmware/** rwklx,
}
```

Status: the profile parses and loads (`apparmor_parser -r`), but rootless Podman refuses to attach it
(host-validation C), so it is kept in the repo, is not copied to `/etc/apparmor.d/` by default (opt-in
`AGENTBOX_APPARMOR_SANDBOX=1` in `provision.sh`) and **is not in effect** (`/etc/apparmor.d/agentbox-sandbox` does
not exist on this host). Residual risk 4 is active. Re-test when podman/crun are upgraded or if a rootful launcher
for tenant containers is ever introduced.

## H. systemd drop-ins and resource-limit table

The agent writes both from `userDropin()` / `sliceDropin()` in `apps/agent/src/argv.ts`, via
`writeDropins()` in `apps/agent/src/tenants.ts`, then `systemctl daemon-reload`.

`/etc/systemd/system/user@<U>.service.d/agentbox.conf`:

```
[Unit]
Description=AgentBox workspace <ws>

[Service]
PrivateTmp=yes
ProtectSystem=strict
ReadWritePaths=/srv/agentbox/tenants/<ws> /run/user/<U>
InaccessiblePaths=-/home -/root
ProtectKernelModules=yes
ProtectClock=yes
LockPersonality=yes
```

`/etc/systemd/system/user-<U>.slice.d/agentbox.conf`:

```
[Slice]
MemoryMax=<memoryMb + 512>M
TasksMax=<pidsLimit + 512>
CPUQuota=<round(cpus*100 + 50)>%
```

Deviations from the plan (host-validation E): `ProtectHome=yes` made the user manager fail
(`Failed to allocate manager object: Permission denied`) and is replaced by `InaccessiblePaths=-/home -/root`;
`ProtectKernelLogs=yes` made containers fail to start and was dropped. `NoNewPrivileges` is deliberately absent on `user@` because `newuidmap` is setuid, and
`ProtectControlGroups` is absent because podman manages cgroups. The slice drop-in was verified:
`systemctl show user-204999.slice` reported `MemoryMax=1073741824 TasksMax=768 CPUQuotaPerSecUSec=1.5s`.
`user@U.service` delegates `cpu cpuset io memory pids`
(`/etc/systemd/system/user@.service.d/agentbox-delegate.conf`).

Tenant lifecycle facts that matter for security: tenants linger; the stop path runs `podman stop -t 20 abx-ws`,
`podman rm -f abx-ws` then `systemctl stop user@U.service`; delete disables linger, clears the quota, removes
subids, the user and both drop-ins.

| Abuse                     | Control                                                                                                                                                                            | Effect                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Fork bomb                 | `--pids-limit <P>` (cgroup `pids.max`), `--ulimit nproc=<P+256>`, slice `TasksMax=<P+512>`                                                                                         | `pids.current` capped at P; host stays responsive                                                     |
| Memory bomb               | `--memory <M>m` = `--memory-swap <M>m` (no swap), `--oom-score-adj 1000`, slice `MemoryMax=<M+512>M`; `workspace-init` restarts T3/code-server if the OOM killer picks one of them | process OOM-killed inside the cgroup, `oom_kill` increments, workspace keeps running, host unaffected |
| Disk fill                 | XFS `bsoft=0.95*N`, `bhard=N`, `ihard=4000000` for the tenant UID; tmpfs `size=` on `/tmp` 2g, `/var/tmp` 512m, `/run` 64m                                                         | `Disk quota exceeded`; inode exhaustion bounded                                                       |
| FD exhaustion             | `--ulimit nofile=65536:65536`                                                                                                                                                      | per-process cap, bounded by tenant memory                                                             |
| CPU hogging               | `--cpus <C>` (`cpu.max`), slice `CPUQuota`, cgroup `cpu.weight` fairness                                                                                                           | at most C cores; others keep their share                                                              |
| Infinite execution        | worker `maxAwakeHours` + idle hibernate (`evaluateActivity`), billing                                                                                                              | workspace stopped after max awake or idle timeout                                                     |
| Log flood                 | `--log-driver k8s-file --log-opt max-size=10mb`                                                                                                                                    | log file bounded                                                                                      |
| Core dumps                | `--ulimit core=0`, `fs.suid_dumpable=0`                                                                                                                                            | no core files                                                                                         |
| Connection storms / scans | nft `newconn_rate` (200/s, burst 400) per UID, SMTP drop                                                                                                                           | rate-limited, port 25 blocked                                                                         |

Observed caveat (host-validation G): a **buffered** `dd` (no `oflag=direct`) inside a memory-limited container
was killed by the memory cgroup (page cache on the loop-backed XFS) at ~531 MB / ~938 MB, before the disk quota
was reached. The quota itself is enforced for direct I/O (`Disk quota exceeded` at 1072693248 bytes for a 1 GiB
quota). Heavy buffered writers can therefore be OOM-killed before they hit the disk quota.

## I. Forbidden options

Never passed by the agent and never accepted from user input (no user-supplied image refs, OCI config or
podman flags exist in `agent-api.ts`):

- `--privileged`, `--network=host`, `--pid=host`, `--ipc=host`, `--uts=host`, `--userns=host`,
  `--security-opt seccomp=unconfined`, `--security-opt apparmor=unconfined`, any `--cap-add`, any `--device`.
- Mounts of `/`, `/home`, `/etc`, `/proc`, `/sys`, `/run/user`, `/var/lib/agentbox-cp`, another tenant's
  directory, `~/.ssh`, and the Podman or Docker sockets. The only bind mount is
  `/srv/agentbox/tenants/<ws>/workspace:/workspace:rw,nosuid,nodev`.
- `NoNewPrivileges=yes` on `user@` (breaks setuid `newuidmap`), tenants in `sudo`, reusing a UID or slot.
- Image IDs other than `^[0-9a-f]{64}$` that exist under `/srv/agentbox/rootfs`.

## J. Test plan

`sudo infra/tests/sandbox-security.sh` (root; not safe to run concurrently with another run: it owns slots 4997
`sectest` and 4996 `secother`). It provisions both through `/run/agentbox/agent.sock` (diskGb 2, memoryMb 2048,
pidsLimit 512, cpus 1), starts both, runs the checks, and always deletes both tenants in an EXIT trap. Commands
inside the sandbox use the tenant transport `systemd-run --machine=abx-sectest@ --user --quiet --wait --pipe
--collect podman exec abx-ws ...`; the simulated escape uses `runuser -u abx-sectest` on the host. It prints
`PASS`/`FAIL`/`INFO` per check and exits non-zero if any check FAILed. `IMAGE_ID` picks the rootfs; `STRICT_UNSHARE=1`
turns the known AppArmor gap into a hard failure.

Expected output on this host (AppArmor not applied): every line `PASS`, plus these `INFO` lines:

```
=== AgentBox sandbox security test  image=23ed671240c9e5e4cc10845336917f34c50d181ea5fd6a8861ade5b42985fb26
PASS  provision sectest + secother and start both (health on both ports)
PASS  internet: https://example.com -> 200
PASS  positive control: tcp 1.1.1.1:443 connects
PASS  blocked: 192.168.124.1:80   (also 192.168.124.10:22, 10.0.0.1:80, 172.17.0.1:80, 192.168.1.1:80,
                                   100.80.0.1:22, 100.96.0.10:80, 169.254.169.254:80, 1.1.1.1:25)
PASS  metadata: curl http://169.254.169.254 -> no response
PASS  loopback 127.0.0.1:{22,3000,3001,5432,29992,29993} not reachable from sandbox
PASS  ipv6: curl -6 fails
PASS  nft: @blocked4 counter incremented / tcp dport 25 counter incremented
INFO  nft: ipv6 drop counter ... (informational; pasta runs --ipv4-only)
PASS  id -u == 1000 / CapEff == 0 / CapBnd == 0 / NoNewPrivs == 1 / Seccomp == 2
PASS  write /etc/x fails / write /usr/x fails / write /workspace works / write /tmp works
INFO  KNOWN RISK #4: unshare -Ur succeeds; AppArmor not applied to rootless sandboxes (/proc/1/attr/current='crun (unconfined)'), see docs/security/sandbox.md B/G
PASS  unshare -Ur true: known residual risk recorded (not a regression)
PASS  escape shell runs as uid 204997
PASS  escape: cat /home/kyle/.ssh/known_hosts -> permission denied
PASS  escape: ls /var/lib/agentbox-cp -> permission denied
PASS  escape: ls /srv/agentbox/tenants/secother -> permission denied
PASS  escape: cat /etc/agentbox/agent.env -> permission denied
PASS  escape: agent socket unreachable (0600 abx-cp)
PASS  escape: sudo -n true fails
PASS  escape: curl 127.0.0.1:{3000,3001,29992,29993} blocked (root got <http code>)
PASS  escape: curl 127.0.0.1:5432 fails / curl 100.80.0.1:22 blocked
PASS  memory bomb killed (exit 137) / memory.events oom_kill incremented (0 -> 1+)
PASS  workspace container survived the memory bomb
PASS  host MemAvailable ... kB > 4 GiB
PASS  dd oflag=direct fails with 'Disk quota exceeded'
PASS  file stopped near quota (~2147483648 bytes)
INFO  buffered dd: <quota hit | no quota message (likely killed by the memory limit)>; ...
PASS  fork bomb actually ran (peak pids.current=~512)
PASS  pids.current peak <= pidsLimit 512
PASS  systemctl is-system-running answered within 2 s on all 12 samples
PASS  container recovered after bomb
--- cleanup: deleting tenants
deleted sectest
deleted secother
=== <N> passed, 0 failed
```

(The loopback target ports are `20000 + 2*4996 = 29992` and `29993`.) With a future working AppArmor profile
(`/proc/1/attr/current` = `agentbox-sandbox`) the `unshare -Ur true` line must instead read
`PASS  unshare -Ur true fails`; the script enforces that automatically. A `FAIL` for any other line is a
regression and a non-zero exit.

Checks beyond the script: `docs/security/host-validation.md` (A-G) documents the one-off validation of the
primitives; re-run the script after any change to D, E, F, H, the image, podman or the kernel.

## K. Protection evaluation

| Control                                                                            | Protects against                                                     | Benefit                              | Overhead                         | Compat                             |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------ | -------------------------------- | ---------------------------------- |
| User namespaces, `keep-id:uid=1000,gid=1000`, tenant UID range                     | root-in-container = host root; cross-tenant file access              | high                                 | ~0                               | low                                |
| `--cap-drop=ALL`                                                                   | capability-based escapes, raw sockets, mounts                        | high                                 | ~0                               | low                                |
| `no-new-privileges`                                                                | setuid/file-cap escalation                                           | high                                 | ~0                               | low                                |
| Podman default seccomp (`Seccomp: 2`)                                              | dangerous syscalls, kernel attack surface                            | high                                 | ~0                               | low                                |
| AppArmor deny-only profile (G)                                                     | `/proc/sys`, mounts, nested userns                                   | **none today** (not applied, risk 4) | ~0                               | low                                |
| Read-only rootfs + tmpfs + `nosuid,nodev` mounts                                   | persistence, setuid, device nodes                                    | high                                 | ~0                               | low                                |
| nftables `skuid` + `blocked4`/`extra_blocked4` (E)                                 | LAN, VPN, metadata, loopback services, SMTP, IPv6, connection floods | high                                 | ~0                               | low                                |
| cgroup v2 limits (memory, pids, cpu) via `--memory` etc. and slice drop-ins        | fork/memory bombs, CPU starvation                                    | high                                 | ~0                               | low                                |
| RLIMITs (`nproc`, `nofile`, `core`)                                                | FD/process exhaustion, core dumps                                    | medium                               | ~0                               | low                                |
| sysctl set (F)                                                                     | kernel info leaks, bpf/perf/userfaultfd/io_uring attack surface      | high                                 | ~0                               | low-medium (`io_uring_disabled=2`) |
| Module blacklist                                                                   | exploit-prone legacy protocols and filesystems                       | medium                               | ~0                               | low                                |
| XFS user quota on loop with direct I/O                                             | disk and inode exhaustion                                            | high                                 | low                              | low (buffered-writer caveat, H)    |
| Per-tenant `user@U` with `PrivateTmp`, `ProtectSystem=strict`, `InaccessiblePaths` | limits what podman and an escaped process can see/write              | medium                               | ~10 MB RAM per awake tenant      | low (two directives dropped, B)    |
| pasta networking                                                                   | per-tenant userspace network, no host netns access                   | high                                 | network overhead medium, CPU low | low                                |

Not used, with reasons:

- **gVisor, Kata, Firecracker, other VMs**: out of scope by design; they add overhead or need KVM/runtime
  integration. Kernel LPE is accepted as residual risk 1.
- **Mandatory outbound proxy**: heavy operationally and breaks general tooling; nftables per-UID egress rules
  give the needed isolation.
- **auditd syscall logging**: high volume and overhead for little signal at this stage.
- **`hidepid`**: breaks logind and polkit (risk 5).
- **`user.max_user_namespaces=0` / `unprivileged_userns_clone=0`**: rootless Podman would not work.
