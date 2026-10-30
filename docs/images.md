# Workspace images

## Rules

1. **Slim only.** An image contains T3 Code, VS Code (code-server) and the plumbing the per-workspace
   toolchain needs: apt basics, git, `gh`, `uv`, `mise`, `workspace-init` and `env.sh`. It must not
   bake Node, Codex, Claude Code, Oh My Pi or any language runtime. Users install everything else
   themselves ([`toolchain.md`](toolchain.md)). There is no `SLIM` build argument and no non-slim path.
2. **Version tag = build number, 3 digits.** Every build gets the next number (`001`, `002`, ...) and
   is tagged `localhost/agentbox-workspace:<NNN>`. The number is stored in `images.version` (integer,
   unique, allocated as `max + 1` when the build row is inserted, never reused) and is what the admin
   console shows. Existing images were numbered by creation date by migration 0010. Never build
   with an ad-hoc tag.

## Building

Use `/admin/images` ("Build a new image", T3 ref only). The web action inserts the `images` row with
the next version and a `build_image` job; the worker passes `version` to the agent, which runs

```sh
podman build --pull=always --no-cache --build-arg T3_REF=<ref> \
  -t localhost/agentbox-workspace:<NNN> /opt/agentbox/images/workspace
```

as the build user, exports the rootfs, scans it with Trivy and reads `/opt/agentbox/versions.json`
into `images.manifest`. The Podman tag is removed after the export (the rootfs directory is what
workspaces start from, addressed by image id), so the tag exists for the duration of the build and
in the build log.

Building by hand (e.g. on the build host) follows the same rule: take the number from the admin
console's image list (`max + 1`) and use its 3-digit form as the tag.

## Activating

Exactly one image is active; new starts use it. Activation, pinning and bulk moves are gated by the
toolchain manifest check (see `toolchain.md`).
