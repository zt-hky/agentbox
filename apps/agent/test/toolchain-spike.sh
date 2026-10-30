#!/usr/bin/env bash
# Real-container check of src/toolchain/apply.sh. NOT run by vitest.
#
# Drives the script exactly like the host agent does (script + plan written over stdin with
# `podman exec -i`, run detached-style via `bash apply.sh <run-dir>`) inside a throwaway rootless
# container, with baked node/claude hidden from PATH. Prints a transcript for docs/toolchain-spike.md.
#
#   SPIKE_MISE=/path/to/mise  (optional; downloaded from GitHub when unset)
#   SPIKE_IMAGE=localhost/agentbox-workspace:dev
#   SPIKE_EXTRA=1             also install pi/opencode/grok/muse
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
AGENT_DIR=$(cd "$HERE/.." && pwd)
SCRIPT="$AGENT_DIR/src/toolchain/apply.sh"
IMAGE=${SPIKE_IMAGE:-localhost/agentbox-workspace:dev}
MISE_VERSION=2026.10.23
NAME="abx-spike-$$"
ROOT=$(mktemp -d /tmp/spike-agent-run.XXXXXX)
WS="$ROOT/ws"
MISEDIR="$ROOT/mise"
mkdir -p "$WS/home" "$MISEDIR"

cleanup() {
  podman rm -f -t 1 "$NAME" >/dev/null 2>&1
  chmod -R u+w "$ROOT" 2>/dev/null
  rm -rf "$ROOT"
}
trap cleanup EXIT

if [ -n "${SPIKE_MISE:-}" ]; then
  cp "$SPIKE_MISE" "$MISEDIR/mise"
else
  curl -fsSL "https://github.com/jdx/mise/releases/download/v$MISE_VERSION/mise-v$MISE_VERSION-linux-x64.tar.gz" |
    tar -xz -C "$ROOT" && cp "$ROOT/mise/bin/mise" "$MISEDIR/mise"
fi
chmod +x "$MISEDIR/mise"

podman run -d --name "$NAME" --userns=keep-id:uid=1000,gid=1000 --user 1000:1000 \
  --cap-drop=ALL --security-opt=no-new-privileges \
  -e HOME=/workspace/home -e PATH=/opt/spike:/usr/bin:/bin \
  -v "$WS:/workspace" -v "$MISEDIR:/opt/spike:ro" "$IMAGE" sleep infinity >/dev/null || exit 1

cx() { podman exec -i -u 1000 --workdir /workspace/home "$NAME" "$@"; }
# shell snippet inside the container with the same env the toolchain run uses
cxs() { podman exec -u 1000 --workdir /workspace/home "$NAME" bash -c 'export MISE_DATA_DIR=$HOME/.local/share/mise MISE_CACHE_DIR=$HOME/.cache/mise MISE_YES=1 MISE_NO_CONFIG=1 MISE_QUIET=1 NO_COLOR=1; export PATH=$HOME/.agentbox/bin:$PATH; '"$1"; }
farm() { cxs 'export PATH=$HOME/.agentbox/bin:/opt/spike:/usr/bin:/bin; '"$1"; }

section() { printf '\n## %s\n\n' "$*"; }
show() { printf '$ %s\n' "$1"; }

# plan <mode> <runId> <tool:action:version[:muse-url|muse-checksum]>...  -> validated toolchainApplyRequest JSON
plan() {
  (cd "$AGENT_DIR" && node --input-type=module - "$@" <<'JS'
import { toAgentStep, toolchainApplyRequestSchema } from "@agentbox/core/toolchain";
const [mode, runId, ...specs] = process.argv.slice(2);
const steps = specs.map((s) => {
  const [tool, action, version = "", url = "", checksum = ""] = s.split("|");
  const info = url ? { meta: { url, checksum } } : undefined;
  return toAgentStep({ tool, action, from: null, to: version || null }, info);
});
process.stdout.write(JSON.stringify(toolchainApplyRequestSchema.parse({ runId, mode, steps })));
JS
  )
}

# run <mode> <runId> <step>...  Writes script + plan over stdin (never argv), runs, prints log and result.json.
RUN_RC=0
run() {
  local mode=$1 id=$2
  shift 2
  local json
  json=$(plan "$mode" "$id" "$@") || { echo "plan generation failed"; return 1; }
  cx sh -c 'umask 077; d=$HOME/.agentbox/runs/$1; mkdir -p "$d" "$HOME/.agentbox/logs" && cat > "$d/apply.sh"' sh "$id" <"$SCRIPT"
  cx sh -c 'umask 077; cat > "$HOME/.agentbox/runs/$1/plan.json"' sh "$id" <<<"$json"
  printf '$ bash ~/.agentbox/runs/%s/apply.sh ~/.agentbox/runs/%s   # steps: %s\n' "$id" "$id" "$*"
  local t0=$SECONDS
  cx bash -c 'set -o pipefail; bash "$HOME/.agentbox/runs/$1/apply.sh" "$HOME/.agentbox/runs/$1" 2>&1 | tee "$HOME/.agentbox/logs/$1.log"' sh "$id" | cut -c1-220
  RUN_RC=${PIPESTATUS[0]}
  echo "# wall $((SECONDS - t0))s"
  printf '\n$ jq -c ".exitCode, (.steps[] | {tool,action,status,version,previous,backend,errorCode,sizeBytes,observed,path,durationMs})" result.json\n'
  cx jq -c '.exitCode, (.steps[] | {tool,action,status,version,previous,backend,errorCode,error,sizeBytes,observed,path,durationMs} | with_entries(select(.value != null)))' "/workspace/home/.agentbox/runs/$id/result.json"
}

show_farm() {
  show 'ls -l ~/.agentbox/bin'
  cx ls -l /workspace/home/.agentbox/bin | tail -n +2 | awk '{ $1=$2=$3=$4=$5=$6=$7=$8=""; print substr($0,9) }'
}

# --- version resolution ---------------------------------------------------------------------------------
section "Environment"
show 'podman run ... localhost/agentbox-workspace:dev sleep infinity   # uid 1000, cap-drop=ALL, no-new-privileges, PATH=/opt/spike:/usr/bin:/bin'
cxs 'mise --version; jq --version; flock --version | head -1; timeout --version | head -1; id; echo "HOME=$HOME"; command -v node claude codex omp || echo "(no baked node/claude/codex/omp on PATH)"'

section "Resolve versions"
NODE_LTS=$(cxs 'mise latest node@lts 2>/dev/null || mise ls-remote node lts | tail -1')
PY312=$(cxs 'mise ls-remote python 3.12 | grep -E "^3\.12\.[0-9]+$" | sort -V | tail -1')
BUN_LATEST=$(cxs 'mise latest bun')
BUN_OLD=1.3.0
CLAUDE=$(cxs 'mise latest aqua:anthropics/claude-code')
CODEX=$(cxs 'mise latest aqua:openai/codex')
OMP=$(cxs 'mise latest github:can1357/oh-my-pi')
COPILOT=$(cxs 'mise latest aqua:github/copilot-cli')
echo "node lts=$NODE_LTS python 3.12=$PY312 bun=$BUN_LATEST (old $BUN_OLD) claude=$CLAUDE codex=$CODEX omp=$OMP copilot=$COPILOT"

# --- first reconcile -------------------------------------------------------------------------------------
section "Run 1: install node, python 3.12, bun $BUN_OLD, claude, codex, omp, copilot"
run apply run1 "node|install|$NODE_LTS" "python|install|$PY312" "bun|install|$BUN_OLD" \
  "claude|install|$CLAUDE" "codex|install|$CODEX" "omp|install|$OMP" "copilot|install|$COPILOT"
echo "# run exit code: $RUN_RC"

if [ "${SPIKE_EXTRA:-0}" = 1 ]; then
  section "Run 2: pi, opencode, grok, muse"
  PI=$(cxs 'mise latest aqua:earendil-works/pi')
  OPENCODE=$(cxs 'mise latest aqua:anomalyco/opencode')
  GROK=$(cxs 'mise latest npm:@xai-official/grok')
  MANIFEST=$(cx curl -fsSL https://api.meta.ai/muse-code/channels/muse-stable | jq -r '.manifest_url')
  MUSE_JSON=$(cx curl -fsSL "$MANIFEST")
  MUSE_VER=$(jq -r '.version' <<<"$MUSE_JSON")
  MUSE_URL=$(jq -r '.artifacts.x86_linux.url' <<<"$MUSE_JSON")
  MUSE_SUM="sha256:$(jq -r ".artifacts.x86_linux.checksum" <<<"$MUSE_JSON")"
  echo "pi=$PI opencode=$OPENCODE grok=$GROK muse=$MUSE_VER"
  run apply run2 "pi|install|$PI" "opencode|install|$OPENCODE" "grok|install|$GROK" "muse|install|$MUSE_VER|$MUSE_URL|$MUSE_SUM"
  echo "# run exit code: $RUN_RC"
fi

section "Farm symlinks and --version through the farm PATH"
show_farm
printf '\n'
show 'PATH=~/.agentbox/bin:/opt/spike:/usr/bin:/bin; <bin> --version'
farm 'for b in node npm npx python python3 pip bun bunx claude codex omp copilot pi opencode grok muse; do command -v "$b" >/dev/null 2>&1 || continue; printf "%-9s %s -> %s\n" "$b" "$(readlink -f "$(command -v "$b")" | sed "s|^/workspace/home/|~/|" | cut -c1-90)" "$("$b" --version 2>&1 | head -n 1 | cut -c1-70)"; done'
printf '\n'
show 'cat ~/.agentbox/toolchain.json | jq -c ".tools | to_entries[] | {id: .key} + .value"'
cx jq -c '.tools | to_entries[] | {id: .key} + .value' /workspace/home/.agentbox/toolchain.json
show 'du -sh ~/.local/share/mise/installs/*   # kept versions only'
cx sh -c 'du -sh "$HOME"/.local/share/mise/installs/*/* 2>/dev/null | sed "s|/workspace/home|~|"'
show 'ls ~/.cache/mise | wc -l   # cache purged'
cx sh -c 'ls "$HOME/.cache/mise" 2>/dev/null | wc -l'

# --- upgrade keeps previous ------------------------------------------------------------------------------
section "Run 3: upgrade bun $BUN_OLD -> $BUN_LATEST (keeps previous)"
run apply run3 "bun|install|$BUN_LATEST"
farm 'echo "bun -> $(readlink -f "$(command -v bun)" | sed "s|/workspace/home/|~/|") : $(bun --version)"'
show 'jq -c .tools.bun toolchain.json'
cx jq -c '.tools.bun' /workspace/home/.agentbox/toolchain.json
show 'ls ~/.local/share/mise/installs/bun'
cx ls /workspace/home/.local/share/mise/installs/bun

section "Run 4: relink (rollback) bun to $BUN_OLD"
run apply run4 "bun|relink|$BUN_OLD"
farm 'echo "bun -> $(readlink -f "$(command -v bun)" | sed "s|/workspace/home/|~/|") : $(bun --version)"'
cx jq -c '.tools.bun | {version, previous}' /workspace/home/.agentbox/toolchain.json
echo "# rollback again to a version that is not kept (must fail with no_previous, links untouched)"
run apply run4b "bun|relink|0.0.1"
farm 'echo "bun still: $(bun --version)"'

section "Run 5: failed install (nonexistent version) leaves old links untouched"
run apply run5 "bun|install|9.9.9" "node|install|$NODE_LTS"
echo "# exit code $RUN_RC (bun failed, node step still ran)"
farm 'echo "bun still: $(readlink -f "$(command -v bun)" | sed "s|/workspace/home/|~/|") : $(bun --version)"'
show 'ls ~/.local/share/mise/installs/bun   # no 9.9.9 left behind'
cx ls /workspace/home/.local/share/mise/installs/bun

section "Run 6: verify (check mode, read-only)"
run check run6 "node|verify" "bun|verify" "claude|verify" "opencode|verify"
echo "# a tool that is not installed reports "skipped" (absent), never "failed""

section "Run 7: concurrent run is refused (flock, exit 75)"
cx bash -c 'mkdir -p "$HOME/.agentbox/runs/run7x"; cp "$HOME/.agentbox/runs/run3/plan.json" "$HOME/.agentbox/runs/run7x/plan.json"; ( flock 9; bash "$HOME/.agentbox/runs/run3/apply.sh" "$HOME/.agentbox/runs/run7x"; echo "exit=$?" ) 9>"$HOME/.agentbox/run.lock"' | cut -c1-200

section "Run 8: remove"
run apply run8 "bun|remove" "node|remove"
show_farm
cx jq -c '.tools | keys' /workspace/home/.agentbox/toolchain.json
show 'ls ~/.local/share/mise/installs'
cx ls /workspace/home/.local/share/mise/installs

section "Run 9: verify after remove (absent tool is skipped, not failed)"
run check run9 "node|verify" "python|verify"
