# Host validation of risky primitives (plan 6.11)

Run on 2026-10-29, host `pc01`: Ubuntu 26.04.1, podman 5.7.0, crun, pasta, cgroup v2, systemd with
`kernel.io_uring_disabled=2` and the rest of `99-agentbox-hardening.conf` applied. Throwaway tenant
`abx-spike`: slot 4999, UID/GID 204999, subuid/subgid `300327616-300393151`
(`300000000 + 4999*65536`), home `/srv/agentbox/tenants/spike`, quota 1 GiB. Helper scripts used are in
`infra/host/spike/` (`create-tenant.sh`, `run-spike.sh`, `delete-tenant.sh`). The spike tenant, its
drop-ins, linger, quota, subuid ranges, `/srv/agentbox/rootfs/spike*` and the root-side pulled
`ubuntu:26.04` image were all removed afterwards.

## Provisioning and post-sysctl smoke test

| Check                                                                                                                                   | Result                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sudo bash infra/host/provision.sh` (twice)                                                                                             | PASS. Both runs print only the "agent bundle not present: skipping" line and the reminders. No `installed ...` lines, so the script is a no-op on re-run. The first run found the host already provisioned by the interrupted earlier run. |
| `nft list tables` before/after                                                                                                          | PASS. `ip/ip6 filter, nat, mangle`, `inet netavark`, `inet cloudflare-warp` untouched; only `inet agentbox` is managed.                                                                                                                    |
| `node -e 1`, `/usr/bin/node -e 1`, `podman ps`, `omp --version` (`omp/18.13.2`), `bun -e 1`, `git -C /home/kyle/personal/t3code status` | PASS with `kernel.io_uring_disabled=2`; nothing broke, so it stays at 2.                                                                                                                                                                   |

## A. Rootless podman through systemd (`user@UID`)

```
sudo systemctl start user@204999.service
sudo systemd-run --machine=abx-spike@ --user --quiet --wait --pipe --collect \
  podman info --format '{{.Host.Security.Rootless}}'
```

Output: `true`. **PASS**, no fallback needed.

Observations that change how the agent must drive it:

- `systemctl start user@U.service` is synchronous; `/run/user/U` exists when it returns, so no polling is needed.
- Without linger, logind stops `user@U.service` (and `/run/user/U`) as soon as the last `systemd-run --machine` session closes (observed: the manager exited ~20 s after the first call). That kills a detached container. **Tenants need `loginctl enable-linger abx-<ws>`** (disable on tenant delete). `enable-linger` returns before the manager is up, so run `systemctl start user@U.service` afterwards.
- `systemd-run ... podman run -d` runs podman in a transient `run-*.service` of the user manager. When that unit finishes, systemd kills the remaining processes in its cgroup, including conmon; the container then exits with 143 within seconds. **Detached `podman run` must add `-p KillMode=process`** (a `systemd-run` property). Verified: the container then survives the call and sits in `.../user@204999.service/user.slice/libpod-<id>.scope`; `podman exec` works across later calls. Foreground (`--wait --pipe`) commands such as `podman info`, `exec` and `stop` need no extra property.
- stdin passes through `--pipe` (used to write the env file with `sh -c 'umask 077; cat > file'`).
- `runuser -u abx-spike -- env XDG_RUNTIME_DIR=/run/user/U podman ...` also works (fallback, not needed). Run it with a cwd the tenant can read (`/`), otherwise it fails with `cannot chdir`.

## B. Shared root-owned `--rootfs`, `--read-only`, full step-7 flags

`ubuntu:26.04` was exported with root `podman create` + `podman export | tar -x --no-same-owner -C /srv/agentbox/rootfs/spike`.

1. First attempt, rootfs exactly as exported:
   `Error: creating /etc/mtab symlink: permission denied`. **FAIL**. Fallback 1 (`--rootfs <dir>:O`) fails identically; the overlay cannot copy up root-owned lower files that are unmapped in the tenant user namespace. The tenant never owns the shared rootfs, so podman cannot create anything in it.
2. Fix (no podman fallback needed): the rootfs itself must already contain everything podman would otherwise create:
   - symlink `/etc/mtab -> ../proc/self/mounts` (podman's export has none),
   - existing empty dir `/workspace`: otherwise `crun: mkdir /workspace: Permission denied`,
   - existing `/etc/hosts`, `/etc/hostname`, `/etc/resolv.conf` (present as empty files in the ubuntu image), `/tmp`, `/var/tmp`, `/run`,
   - **no** leftover `/run/.containerenv` (created if the exported container was ever started; `crun: open run/.containerenv: Permission denied`). Remove it after export.

   The image Containerfile (or the agent's export step) must guarantee these. With them in place:

```
$ run-spike.sh id        # full step-7 flags, apparmor dropped (see C)
uid=1000(ubuntu) gid=1000(ubuntu) groups=1000(ubuntu)
$ ... cat /proc/self/uid_map
         0          1       1000
      1000          0          1
      1001       1001      64536
$ ... touch /etc/x          -> Read-only file system
$ ... echo hi > /workspace/x -> ok;   touch /tmp/x -> ok
```

**PASS** (with the rootfs preconditions above; fallbacks 1 and 2 not used). Caps, resource limits verified in the libpod scope cgroup: `memory.max=536870912` (512m), `pids.max=256`, `cpu.max=100000 100000` (1 CPU). `Seccomp: 2` (podman default filter active).
Note: the rootfs lives on `/srv/agentbox` (`nosuid,nodev`), so setuid binaries in the image do nothing and there are no device nodes in it (podman provides `/dev`).

## C. AppArmor profile on rootless containers

Profile `agentbox-sandbox` was loaded (`apparmor_parser -r`, `loaded`), then:

```
podman run ... --security-opt=apparmor=agentbox-sandbox ... cat /proc/1/attr/current
Error: apparmor profile "agentbox-sandbox" specified, but Apparmor is not enabled on this system
```

**FAIL.** Rootless podman considers AppArmor disabled and refuses the option even with the profile loaded. Without the option `/proc/1/attr/current` is `crun (unconfined)`. Fallback applied: drop the option and record the residual risk **"AppArmor not applied to rootless sandboxes"**. `provision.sh` therefore does not install/load the profile by default (opt in with `AGENTBOX_APPARMOR_SANDBOX=1`); the profile file is kept in `infra/host/files/etc/apparmor.d/`. Compensating controls: seccomp default filter, `--cap-drop=ALL`, `no-new-privileges`, host `apparmor_restrict_unprivileged_userns=1`, nested `unshare -U` inside the container still succeeds (exit 0) because the container is unconfined by AppArmor; this is the residual risk.

## D. pasta network options

`--network pasta:--no-map-gw,--ipv4-only,--map-guest-addr,none` is **accepted as written**. **PASS**, nothing dropped. Container sees resolver `1.1.1.1/1.0.0.1` (from `--dns`) and the host's default route in `/proc/net/route`. Port publishing `-p 127.0.0.1:29998:3773` works: a TCP server in the container answered `HTTP/1.0 200` on `curl http://127.0.0.1:29998/` from the host. Minor leak: `/etc/resolv.conf` also carries the host's `search tail776a09.ts.net` line.

## E. Per-tenant `user@UID.service` drop-in

The plan's full drop-in makes the user manager fail (`Failed to allocate manager object: Permission denied`). Bisected one directive at a time (rerunning B each time):

| Directive                                                                          | Result                                                                                        |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `PrivateTmp=yes`                                                                   | OK                                                                                            |
| `ProtectSystem=strict` + `ReadWritePaths=/srv/agentbox/tenants/<ws> /run/user/<U>` | OK                                                                                            |
| `ProtectKernelModules=yes`, `ProtectClock=yes`, `LockPersonality=yes`              | OK                                                                                            |
| `ProtectHome=yes` (and `read-only`)                                                | **user manager fails to start** (hides `/run/user`)                                           |
| `ProtectKernelLogs=yes`                                                            | user manager starts, **container fails**: `crun: mount proc to proc: Operation not permitted` |

Fallback applied (removed `ProtectHome` and `ProtectKernelLogs`; `InaccessiblePaths=-/home -/root` replaces ProtectHome). With the final drop-in B passes and `/etc` is read-only for podman itself. Slice drop-in `[Slice] MemoryMax=1024M TasksMax=768 CPUQuota=150%` was accepted: `systemctl show user-204999.slice` reports `MemoryMax=1073741824 TasksMax=768 CPUQuotaPerSecUSec=1.5s`; controllers `cpuset cpu io memory pids` are delegated to `user@U.service`. **PASS** with the fallback.

## F. Egress filtering (inside the tenant container, tenant UID 204999)

Rootfs had `curl` added (built as root with `podman run --network host ubuntu:26.04 apt-get install curl ca-certificates`, exported; the default root netavark network hung on this host and is unrelated).

```
https://example.com   => http=200
http://192.168.124.1  => Connection timed out after 3002 ms
http://100.80.0.1     => Connection timed out after 3002 ms
http://169.254.169.254 => Connection timed out after 3002 ms
http://127.0.0.1:22   => Failed to connect (container loopback, not the host)
http://10.0.0.1       => Connection timed out
http://172.17.0.1     => Connection timed out
http://192.168.1.1    => Connection timed out
bash /dev/tcp/1.1.1.1/25 => blocked
curl -6 https://example.com => Failed to connect
```

Counters in `nft list chain inet agentbox output`: `ip daddr @blocked4` went 45 -> 91 packets, `tcp dport 25` 0 -> 4, `meta nfproto ipv6` 2783 -> 2817. **PASS.** Result unchanged after the E drop-in was applied.

## G. Disk quota

`xfs_quota` limit `bsoft=972m bhard=1g ihard=4000000` for UID 204999.

```
dd if=/dev/zero of=/workspace/fill bs=1M oflag=direct
dd: IO error: Disk quota exceeded        # file 1072693248 bytes, quota report 1023.2M
```

**PASS** (the quota is enforced). Observation: _buffered_ `dd` (no `oflag=direct`) inside a 512 m / 900 m memory-limited container was killed (no error message) at 531 MB / 938 MB, below the quota, i.e. by the container memory limit through page cache on the loop-backed XFS rather than by the quota. Heavy buffered writers can therefore be OOM-killed before hitting the disk quota; not investigated further.

## Other findings

- `useradd` prints `uid 204999 outside of the UID_MIN/UID_MAX range` (harmless). `useradd --user-group --uid U` alone would pick GID 1001+, so create the group with `groupadd --gid U abx-<ws>` first and `useradd --uid U --gid U` (as `infra/host/spike/create-tenant.sh` does).
- `userdel abx-<ws>` removes the same-named group; `usermod --del-subuids/--del-subgids` removed the ranges; nothing was left in `/etc/subuid`, `/etc/subgid`, `/var/lib/systemd/linger`, `/etc/systemd/system/*204999*`, `/run/user`.
- `abx-build`: `systemctl start user@992.service` then `systemd-run --machine=abx-build@ --user --quiet --wait --pipe --collect podman info ...` -> `true overlay systemd`; cwd `/var/lib/agentbox-build`, `XDG_RUNTIME_DIR=/run/user/992`. Not exercised: an actual `podman build`.
- Unverified: `T3`/`code-server` health polling, `podman stop -t 20` timing for real workloads, `podman load` per-tenant fallback (not needed), the AppArmor profile in enforcing use.

## Agent contract

**Tenant transport prefix (`runAsTenant(ws, argv)`)**, executed as root by the agent via `execFile`, no shell:

```
["systemd-run", "--machine=abx-<ws>@", "--user", "--quiet", "--wait", "--pipe", "--collect", ...argv]
```

For a detached `podman run -d` (workspace start only) insert `"-p", "KillMode=process"` before `argv`. All other tenant commands (exec, stop, rm, ps, inspect, writes via `sh -c 'umask 077; cat > "$1"' sh <path>` with stdin) use the plain prefix. Run with a cwd the tenant can traverse (e.g. `/`) if the `runuser` fallback is ever used.

**Tenant setup (create)**, in this order: `groupadd --gid U abx-<ws>`; `useradd --uid U --gid U --home-dir /srv/agentbox/tenants/<ws> --create-home --skel /dev/null --shell /usr/sbin/nologin abx-<ws>`; `passwd -l`; `usermod --add-subuids S-(S+65535) --add-subgids S-(S+65535)`; `chmod 0700` home; tenant-owned `workspace/` 0700; `xfs_quota -x -c 'limit -u bsoft=.. bhard=.. ihard=4000000 U' /srv/agentbox`; write both drop-ins; `systemctl daemon-reload`; `loginctl enable-linger abx-<ws>`. On start: `systemctl start user@U.service` (synchronous; `/run/user/U` exists afterwards; no waiting loop needed). No `podman system migrate` and no per-tenant `storage.conf` were needed: the rootfs is shared and `--rootfs` does not use tenant image storage.

**Image/rootfs preconditions** (Containerfile or the agent's export step): `/etc/mtab -> ../proc/self/mounts`, empty `/workspace`, `/tmp`, `/var/tmp`, `/run`, files `/etc/hosts`, `/etc/hostname`, `/etc/resolv.conf`, and delete `/run/.containerenv` after export; `/srv/agentbox/rootfs/<imageId>` readable by all (0755, root-owned).

**Final `podman run` argv** (appended to the tenant prefix with `-p KillMode=process`; AppArmor option removed):

```
podman run -d --replace --name abx-ws --hostname <ws>
  --rootfs --read-only
  --userns=keep-id:uid=1000,gid=1000 --user 1000:1000
  --cap-drop=ALL --security-opt=no-new-privileges
  --network pasta:--no-map-gw,--ipv4-only,--map-guest-addr,none --dns 1.1.1.1 --dns 1.0.0.1
  -p 127.0.0.1:<20000+2s>:3773 -p 127.0.0.1:<20001+2s>:8080
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

Note `--rootfs` is a boolean flag; the rootfs path is the positional image argument. Everything above (minus `-d --replace`, the label and `--stop-timeout`, which only matter for the long-running case, plus a `--rm`) ran successfully in `run-spike.sh`; the detached form with `--replace` and `-p KillMode=process` was verified separately.

**User drop-in `/etc/systemd/system/user@<U>.service.d/agentbox.conf`** (final):

```
[Service]
PrivateTmp=yes
ProtectSystem=strict
ReadWritePaths=/srv/agentbox/tenants/<ws> /run/user/<U>
InaccessiblePaths=-/home -/root
ProtectKernelModules=yes
ProtectClock=yes
LockPersonality=yes
```

(`ProtectHome` and `ProtectKernelLogs` removed; no `NoNewPrivileges`, no `ProtectControlGroups`.) Slice drop-in `/etc/systemd/system/user-<U>.slice.d/agentbox.conf` as in the plan (`MemoryMax`, `TasksMax`, `CPUQuota`) works unchanged.

**Stop**: `podman stop -t 20 abx-ws`, `podman rm -f abx-ws` (plain prefix), then `systemctl stop user@U.service` (works with linger on; user manager restarts only on the next start). **Delete**: stop container, `loginctl disable-linger abx-<ws>`, `systemctl stop user@U.service`, clear quota, `usermod --del-subuids/--del-subgids`, `userdel`, `rm -rf --one-file-system` home, remove both drop-ins, `daemon-reload` (`infra/host/spike/delete-tenant.sh`).

**cgroup path**: `podman inspect --format '{{.State.CgroupPath}}' abx-ws` returns `/user.slice/user-<U>.slice/user@<U>.service/user.slice/libpod-<id>.scope`; stats are read from `/sys/fs/cgroup` + that path.

**abx-build transport**: `systemctl start user@<uidOf abx-build>.service` (UID is 992 on this host; look it up with `id -u abx-build`), then the same prefix with `--machine=abx-build@` (no linger; the long build runs under `--wait --pipe`, which holds the session open). `podman info` returned `true overlay systemd`. Builds and the `podman create`/`export` run in that prefix; the rootfs extraction (`tar -x --no-same-owner`) and the post-export fixups above run as root.

**AppArmor**: not applied (residual risk, see C).
