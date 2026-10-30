#!/usr/bin/env bash
# AgentBox toolchain apply script. Static: shipped inside the host agent bundle and written into the
# workspace container over stdin. Everything variable comes from <run-dir>/plan.json (validated by the
# agent with toolchainApplyRequestSchema); nothing from the plan is ever evaluated as shell.
#
# usage: apply.sh <run-dir>      (stdout/stderr are the run log; the agent redirects them)
# files: <run-dir>/plan.json (in), pid, steps.jsonl, result.json (out)
# exit : 0 all steps ok, 1 some step failed, 75 another run holds ~/.agentbox/run.lock
set -uo pipefail

RUN_DIR=${1:?usage: apply.sh <run-dir>}
: "${HOME:?HOME must be set}"

# --- environment (mirrors /opt/agentbox/env.sh; used when the image does not ship it) --------------
if [ -r /opt/agentbox/env.sh ]; then
  # shellcheck disable=SC1091
  . /opt/agentbox/env.sh
else
  export MISE_DATA_DIR="${MISE_DATA_DIR:-$HOME/.local/share/mise}"
  export MISE_CACHE_DIR="${MISE_CACHE_DIR:-$HOME/.cache/mise}"
  export NPM_CONFIG_PREFIX="${NPM_CONFIG_PREFIX:-$HOME/.npm-global}"
  case ":$PATH:" in
    *":$HOME/.agentbox/bin:"*) ;;
    *) export PATH="$HOME/.agentbox/bin:$HOME/.npm-global/bin:$HOME/.local/bin:$PATH" ;;
  esac
fi
export MISE_YES=1 MISE_NO_CONFIG=1 MISE_QUIET=1 NO_COLOR=1

AGENTBOX_DIR="$HOME/.agentbox"
BIN_DIR="$AGENTBOX_DIR/bin"
STATE="$AGENTBOX_DIR/toolchain.json"
PLAN="$RUN_DIR/plan.json"
STEPS="$RUN_DIR/steps.jsonl"
RESULT="$RUN_DIR/result.json"
MISE_OUT="$RUN_DIR/mise.out"

INSTALL_TIMEOUT=600
SMOKE_TIMEOUT=20

CANCELLED=""
CURRENT_TOOL=""
CURRENT_ACTION=""
STEP_START=0

mkdir -p "$AGENTBOX_DIR" "$BIN_DIR" "$RUN_DIR"

# --- logging and records -----------------------------------------------------------------------------
log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
now_ms() {
  local t=${EPOCHREALTIME//[.,]/}
  printf '%s' "$((t / 1000))"
}
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# emit <tool> <action> <status> [key value]...   Appends one stepRecordSchema line; empty values are omitted.
emit() {
  local tool=$1 action=$2 status=$3 k v expr='{tool:$tool,action:$action,status:$status}'
  shift 3
  local args=(--arg tool "$tool" --arg action "$action" --arg status "$status")
  while [ $# -ge 2 ]; do
    k=$1
    v=$2
    shift 2
    [ -n "$v" ] || continue
    case $k in
      sizeBytes | durationMs) args+=(--argjson "$k" "$v") ;;
      *) args+=(--arg "$k" "$v") ;;
    esac
    expr+=" + {$k:\$$k}"
  done
  jq -nc "${args[@]}" "$expr" >>"$STEPS"
}

# one-line, control-free, bounded error text taken from the end of captured output
tail_error() {
  tail -n 4 "$1" 2>/dev/null | tr -d '\000-\010\013-\037' | tr '\n' ' ' | cut -c1-400
}

# --- observed state (~/.agentbox/toolchain.json) -------------------------------------------------------
state_init() {
  if ! jq -e '.tools | type == "object"' "$STATE" >/dev/null 2>&1; then
    printf '{"tools":{}}\n' >"$STATE.tmp.$$" && mv -f "$STATE.tmp.$$" "$STATE"
  fi
}
state_get() { jq -c --arg id "$1" '.tools[$id] // empty' "$STATE" 2>/dev/null; }
state_set() {
  jq --arg id "$1" --argjson v "$2" '.tools[$id] = $v' "$STATE" >"$STATE.tmp.$$" &&
    mv -f "$STATE.tmp.$$" "$STATE"
}
state_del() {
  jq --arg id "$1" 'del(.tools[$id])' "$STATE" >"$STATE.tmp.$$" && mv -f "$STATE.tmp.$$" "$STATE"
}

# --- result + cleanup ----------------------------------------------------------------------------------
write_result() {
  local rc=$1
  jq -s --argjson rc "$rc" --arg ts "$(now_iso)" --slurpfile st "$STATE" \
    '{exitCode: $rc, finishedAt: $ts, steps: [.[] | select(.status != "running")], tools: ($st[0].tools // {})}' \
    "$STEPS" >"$RESULT.tmp.$$" 2>/dev/null && mv -f "$RESULT.tmp.$$" "$RESULT"
}

purge_cache() {
  local dir=${MISE_CACHE_DIR:-}
  case $dir in
    '' | / | "$HOME" | "$HOME/") return 0 ;;
  esac
  [ -d "$dir" ] && find "$dir" -mindepth 1 -delete 2>/dev/null
  return 0
}

on_exit() {
  local rc=$?
  rm -rf "$AGENTBOX_DIR/stage/$$" 2>/dev/null
  [ -z "$CANCELLED" ] || return 0
  if [ -n "$CURRENT_TOOL" ]; then
    emit "$CURRENT_TOOL" "$CURRENT_ACTION" failed errorCode install_failed error "apply script exited unexpectedly (code $rc)"
    [ "$rc" -ne 0 ] || rc=1
  fi
  write_result "$rc"
}

# --- lock, pid, traps ----------------------------------------------------------------------------------
exec 9>"$AGENTBOX_DIR/run.lock"
if ! flock -n 9; then
  log "another toolchain run holds $AGENTBOX_DIR/run.lock"
  : >"$STEPS"
  printf '{"exitCode":75,"finishedAt":"%s","steps":[],"tools":{}}\n' "$(now_iso)" >"$RESULT"
  exit 75
fi
: >"$STEPS"
printf '%s\n' "$$" >"$RUN_DIR/pid"
trap on_exit EXIT
trap 'CANCELLED=1; exit 143' TERM INT HUP

state_init

if ! jq -e '.steps | type == "array"' "$PLAN" >/dev/null 2>&1; then
  log "plan.json is missing or invalid"
  exit 2
fi
MODE=$(jq -r '.mode' "$PLAN")

# --- helpers -------------------------------------------------------------------------------------------

# classify <exit-code> <output-file> -> toolchain error code
classify() {
  local rc=$1 f=$2
  if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
    echo timeout
  elif grep -qiE 'ENOSPC|no space left|disk quota exceeded' "$f" 2>/dev/null; then
    echo quota
  elif grep -qiE 'checksum|attestation|verification failed|signature' "$f" 2>/dev/null; then
    echo integrity
  elif grep -qiE '\b(403|429)\b|rate.?limit' "$f" 2>/dev/null; then
    echo rate_limited
  elif grep -qiE '\b404\b|no versions? found|not found' "$f" 2>/dev/null; then
    echo version_not_found
  else
    echo install_failed
  fi
}

# mise_spec <spec> <step-index> <backend-index> <version> -> spec string with options, e.g. http:muse[url=..,checksum=..]@1.2
mise_target() {
  local opts
  opts=$(jq -r --argjson i "$1" --argjson b "$2" \
    '.steps[$i].backends[$b].options // {} | to_entries | map("\(.key)=\(.value)") | join(",")' "$PLAN")
  if [ -n "$opts" ]; then printf '%s[%s]@%s' "$3" "$opts" "$4"; else printf '%s@%s' "$3" "$4"; fi
}

# install_path <spec> <version> -> directory of an installed version (empty when absent)
install_path() {
  mise ls --json 2>/dev/null |
    jq -r --arg k "$1" --arg v "$2" '(.[$k] // [])[] | select(.version == $v and .installed != false) | .install_path' 2>/dev/null |
    head -n 1
}

# installed_versions <spec> -> one exact version per line
installed_versions() {
  mise ls --json 2>/dev/null | jq -r --arg k "$1" '(.[$k] // [])[] | select(.installed != false) | .version' 2>/dev/null
}

uninstall_version() { timeout --foreground -k 5 120 mise uninstall "$1@$2" >/dev/null 2>&1 || true; }

# locate_bin <install-dir> <file-name> -> path of the executable (empty when absent)
locate_bin() {
  local d=$1 f=$2 c
  # `$d/*/...` covers archives that unpack into one versioned directory (uv, maven, gradle).
  for c in "$d/$f" "$d/bin/$f" "$d/node_modules/.bin/$f" "$d/$f/$f" "$d"/*/"$f" "$d"/*/bin/"$f"; do
    if [ -f "$c" ] && [ -x "$c" ]; then
      printf '%s' "$c"
      return 0
    fi
  done
  return 1
}

# is_shell_script <file>: true when the file starts with a sh/bash shebang. Such scripts commonly locate
# their siblings through `dirname $0` without resolving symlinks (mise's npm shim does), so they get an
# exec wrapper in the farm instead of a symlink.
is_shell_script() {
  local first
  IFS= read -r first <"$1" 2>/dev/null || return 1
  case $first in
    '#!/bin/sh'* | '#!/bin/bash'* | '#!/usr/bin/env sh'* | '#!/usr/bin/env bash'* | '#!/usr/bin/env -S bash'*) return 0 ;;
  esac
  return 1
}

# make_entry <target> <dest>: farm entry for <target> at <dest> (symlink, or exec wrapper for shell scripts)
make_entry() {
  local target=$1 dest=$2 quoted
  if is_shell_script "$target"; then
    quoted=${target//\'/\'\\\'\'}
    printf '#!/bin/sh\n# agentbox-farm-wrapper\nexec '"'"'%s'"'"' "$@"\n' "$quoted" >"$dest" && chmod 755 "$dest"
  else
    ln -s "$target" "$dest"
  fi
}

# stage_links <step-index> <install-dir> <stage-dir>
# Creates correctly named links in <stage-dir> and smoke tests each one. <stage-dir> must be named
# `bin` (npm resolves node as `$(dirname $0)/../bin/node`, as in the real farm).
# Success fills STAGED_LINKS (name=target) and STAGE_OBSERVED; failure sets STAGE_CODE/STAGE_ERROR.
STAGED_LINKS=()
STAGE_CODE=""
STAGE_ERROR=""
STAGE_OBSERVED=""
stage_links() {
  local i=$1 dir=$2 stage=$3 name file optional target out rc first=1
  local -a vargs
  STAGED_LINKS=()
  STAGE_CODE=""
  STAGE_ERROR=""
  STAGE_OBSERVED=""
  mapfile -t vargs < <(jq -r --argjson i "$i" '.steps[$i].versionArgs[]' "$PLAN")
  rm -rf "$stage" && mkdir -p "$stage" || {
    STAGE_CODE=install_failed
    STAGE_ERROR="cannot create staging dir"
    return 1
  }
  while IFS=$'\t' read -r name file optional; do
    if ! target=$(locate_bin "$dir" "$file"); then
      if [ "$optional" = true ]; then
        log "optional bin $name not found in $dir"
        continue
      fi
      STAGE_CODE=missing_bin
      STAGE_ERROR="binary $file not found in install dir"
      return 1
    fi
    make_entry "$target" "$stage/$name"
    out="$stage/.smoke.$name"
    if [ "${#vargs[@]}" -gt 0 ]; then
      PATH="$stage:$PATH" timeout --foreground -k 2 "$SMOKE_TIMEOUT" "$stage/$name" "${vargs[@]}" >"$out" 2>&1 </dev/null
      rc=$?
      if [ "$rc" -ne 0 ]; then
        if [ "$optional" = true ]; then
          log "optional bin $name failed smoke test (exit $rc); not linked"
          rm -f "$stage/$name"
          continue
        fi
        STAGE_CODE=smoke_failed
        STAGE_ERROR="$name ${vargs[*]} exited $rc: $(tail_error "$out")"
        return 1
      fi
      if [ "$first" = 1 ]; then
        STAGE_OBSERVED=$(head -n 1 "$out" | tr -d '\000-\037' | cut -c1-200)
      fi
    fi
    first=0
    STAGED_LINKS+=("$name=$target")
  done < <(jq -r --argjson i "$i" '.steps[$i].bins[] | [.name, (.file // .name), (.optional // false | tostring)] | @tsv' "$PLAN")
  if [ "${#STAGED_LINKS[@]}" -eq 0 ]; then
    STAGE_CODE=missing_bin
    STAGE_ERROR="no binaries to link"
    return 1
  fi
  return 0
}

# resolve_registry_version <spec> <latest|pin> -> exact version mise would install (empty on failure; mise's stderr lands in $MISE_OUT)
resolve_registry_version() {
  local q=$1 out
  [ "$2" = latest ] || q="$1@$2"
  out=$(timeout --foreground -k 5 90 mise latest "$q" 2>"$MISE_OUT" </dev/null | head -n 1)
  if [[ $out =~ ^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$ ]]; then printf '%s' "$out"; else return 1; fi
}

# stage_registry_links <tool> <install-dir> <stage-dir>
# Registry tools declare no bins: every executable of <install-dir>/bin (or of the install root when it
# has no bin/) is linked. A name already owned by another tool in toolchain.json is never overwritten.
# Smoke test: at least one executable was linked; no --version call. Same outputs as stage_links.
stage_registry_links() {
  local tool=$1 dir=$2 stage=$3 root f name owner
  STAGED_LINKS=()
  STAGE_CODE=""
  STAGE_ERROR=""
  STAGE_OBSERVED=""
  rm -rf "$stage" && mkdir -p "$stage" || {
    STAGE_CODE=install_failed
    STAGE_ERROR="cannot create staging dir"
    return 1
  }
  root=$dir
  [ -d "$dir/bin" ] && root=$dir/bin
  for f in "$root"/*; do
    { [ -f "$f" ] && [ -x "$f" ]; } || continue
    name=${f##*/}
    [[ $name =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || continue
    owner=$(jq -r --arg t "$tool" --arg n "$name" \
      '.tools | to_entries[] | select(.key != $t and ((.value.bins // []) | index($n) != null)) | .key' "$STATE" 2>/dev/null | head -n 1)
    if [ -n "$owner" ]; then
      STAGE_CODE=install_failed
      STAGE_ERROR="$name is already linked by $owner; refusing to overwrite it"
      return 1
    fi
    make_entry "$f" "$stage/$name" || continue
    STAGED_LINKS+=("$name=$f")
  done
  if [ "${#STAGED_LINKS[@]}" -eq 0 ]; then
    STAGE_CODE=missing_bin
    STAGE_ERROR="no executables found in the install dir"
    return 1
  fi
  return 0
}

# swap_links: atomically replace each farm link with the staged targets, then drop stale links of the old state.
swap_links() {
  local pair name target
  for pair in "${STAGED_LINKS[@]}"; do
    name=${pair%%=*}
    target=${pair#*=}
    rm -f "$BIN_DIR/.$name.new.$$"
    make_entry "$target" "$BIN_DIR/.$name.new.$$" && mv -T -f "$BIN_DIR/.$name.new.$$" "$BIN_DIR/$name"
  done
}

# bins_json -> JSON array of the names in STAGED_LINKS
bins_json() {
  local pair
  for pair in "${STAGED_LINKS[@]}"; do printf '%s\n' "${pair%%=*}"; done | jq -R . | jq -sc .
}

dir_size() {
  local kb
  kb=$(du -sk "$1" 2>/dev/null | cut -f1)
  printf '%s' "$((${kb:-0} * 1024))"
}

# prune <spec> <keep-version>... : uninstall every installed version of <spec> not listed
prune() {
  local spec=$1 v keep k skip
  shift
  while IFS= read -r v; do
    [ -n "$v" ] || continue
    skip=""
    for k in "$@"; do [ "$v" = "$k" ] && skip=1; done
    [ -n "$skip" ] || {
      log "uninstalling $spec@$v"
      uninstall_version "$spec" "$v"
    }
  done < <(installed_versions "$spec")
}

finish_failed() { # tool action code error [backend]
  local dur=$(($(now_ms) - STEP_START))
  emit "$1" "$2" failed errorCode "$3" error "$4" backend "${5:-}" durationMs "$dur"
  CURRENT_TOOL=""
  OVERALL=1
}

# --- actions -------------------------------------------------------------------------------------------
do_install() {
  local i=$1 tool=$2 version=$3 nback b spec target dir rc code err pre old oldbackend oldversion oldprevious previous stage
  local obs bins size now dur backend_ok="" preexisting registry
  registry=$(jq -r --argjson i "$i" '.steps[$i].registry // false' "$PLAN")
  if [ "$registry" = true ]; then
    spec=$(jq -r --argjson i "$i" '.steps[$i].backends[0].spec' "$PLAN")
    if ! target=$(resolve_registry_version "$spec" "$version"); then
      cat "$MISE_OUT" 2>/dev/null
      finish_failed "$tool" install version_not_found "cannot resolve $spec@$version: $(tail_error "$MISE_OUT")" "$spec"
      return
    fi
    log "$tool: $version resolves to $target"
    version=$target
  fi
  nback=$(jq -r --argjson i "$i" '.steps[$i].backends | length' "$PLAN")
  old=$(state_get "$tool")
  oldbackend=""
  oldversion=""
  oldprevious=""
  if [ -n "$old" ]; then
    oldbackend=$(jq -r '.backend' <<<"$old")
    oldversion=$(jq -r '.version' <<<"$old")
    oldprevious=$(jq -r '.previous // ""' <<<"$old")
  fi
  code=install_failed
  err="no backend succeeded"
  stage="$AGENTBOX_DIR/stage/$$/$tool/bin"
  for ((b = 0; b < nback; b++)); do
    spec=$(jq -r --argjson i "$i" --argjson b "$b" '.steps[$i].backends[$b].spec' "$PLAN")
    target=$(mise_target "$i" "$b" "$spec" "$version")
    preexisting=""
    [ -n "$(install_path "$spec" "$version")" ] && preexisting=1
    log "$tool: mise install $spec@$version (backend $((b + 1))/$nback)"
    timeout --foreground -k 10 "$INSTALL_TIMEOUT" mise install "$target" >"$MISE_OUT" 2>&1 </dev/null
    rc=$?
    cat "$MISE_OUT"
    dir=""
    if [ "$rc" -eq 0 ]; then
      dir=$(install_path "$spec" "$version")
      if [ -z "$dir" ] || [ ! -d "$dir" ]; then
        code=install_failed
        err="mise reported success but $spec@$version is not installed"
        rc=1
      fi
    else
      code=$(classify "$rc" "$MISE_OUT")
      err="mise install $spec@$version failed (exit $rc): $(tail_error "$MISE_OUT")"
    fi
    if [ "$rc" -eq 0 ]; then
      if { [ "$registry" = true ] && stage_registry_links "$tool" "$dir" "$stage"; } ||
        { [ "$registry" != true ] && stage_links "$i" "$dir" "$stage"; }; then
        backend_ok=$b
        break
      fi
      code=$STAGE_CODE
      err="$STAGE_ERROR"
      log "$tool: $err"
    else
      log "$tool: $err"
    fi
    if [ -z "$preexisting" ]; then
      log "$tool: removing partial install $spec@$version"
      uninstall_version "$spec" "$version"
    fi
  done

  if [ -z "$backend_ok" ]; then
    finish_failed "$tool" install "$code" "$err"
    return
  fi

  # Commit point: every non-optional bin passed its smoke test.
  spec=$(jq -r --argjson i "$i" --argjson b "$backend_ok" '.steps[$i].backends[$b].spec' "$PLAN")
  swap_links
  previous=""
  if [ "$oldbackend" = "$spec" ]; then
    if [ "$oldversion" != "$version" ]; then previous=$oldversion; else previous=$oldprevious; fi
    # registry installs keep no previous version (nothing to roll back to)
    [ "$registry" != true ] || previous=""
    # links of the old state that the new install no longer provides
    local stale
    while IFS= read -r stale; do
      [ -n "$stale" ] || continue
      jq -e --arg n "$stale" 'index($n)' <<<"$(bins_json)" >/dev/null 2>&1 || rm -f "$BIN_DIR/$stale"
    done < <(jq -r '.bins[]' <<<"$old")
  elif [ -n "$old" ]; then
    local stale
    while IFS= read -r stale; do
      [ -n "$stale" ] || continue
      jq -e --arg n "$stale" 'index($n)' <<<"$(bins_json)" >/dev/null 2>&1 || rm -f "$BIN_DIR/$stale"
    done < <(jq -r '.bins[]' <<<"$old")
    log "$tool: backend changed ($oldbackend -> $spec); removing old backend versions"
    prune "$oldbackend"
  fi
  bins=$(bins_json)
  size=$(dir_size "$dir")
  now=$(now_iso)
  obs=$STAGE_OBSERVED
  state_set "$tool" "$(jq -nc --arg v "$version" --arg p "$previous" --arg be "$spec" --argjson bins "$bins" \
    --argjson size "$size" --arg at "$now" --arg obs "$obs" \
    '{version: $v, previous: (if $p == "" then null else $p end), backend: $be, bins: $bins, sizeBytes: $size, installedAt: $at, observed: (if $obs == "" then null else $obs end)}')"
  if [ -n "$previous" ]; then prune "$spec" "$version" "$previous"; else prune "$spec" "$version"; fi
  rm -rf "$AGENTBOX_DIR/stage/$$/$tool"
  dur=$(($(now_ms) - STEP_START))
  emit "$tool" install ok version "$version" previous "$previous" backend "$spec" sizeBytes "$size" observed "$obs" durationMs "$dur"
  CURRENT_TOOL=""
  log "$tool: installed $version"
}

do_relink() {
  local i=$1 tool=$2 version=$3 old backend oldversion oldprevious dir stage bins size now dur
  old=$(state_get "$tool")
  if [ -z "$old" ]; then
    finish_failed "$tool" relink no_previous "tool is not managed by the toolchain"
    return
  fi
  backend=$(jq -r '.backend' <<<"$old")
  oldversion=$(jq -r '.version' <<<"$old")
  oldprevious=$(jq -r '.previous // ""' <<<"$old")
  if [ -z "$oldprevious" ] || [ "$oldprevious" != "$version" ]; then
    finish_failed "$tool" relink no_previous "no kept previous version $version" "$backend"
    return
  fi
  dir=$(install_path "$backend" "$version")
  if [ -z "$dir" ] || [ ! -d "$dir" ]; then
    finish_failed "$tool" relink no_previous "previous install $version is gone" "$backend"
    return
  fi
  stage="$AGENTBOX_DIR/stage/$$/$tool/bin"
  if ! stage_links "$i" "$dir" "$stage"; then
    finish_failed "$tool" relink "$STAGE_CODE" "$STAGE_ERROR" "$backend"
    return
  fi
  swap_links
  bins=$(bins_json)
  size=$(dir_size "$dir")
  now=$(now_iso)
  state_set "$tool" "$(jq -nc --arg v "$version" --arg p "$oldversion" --arg be "$backend" --argjson bins "$bins" \
    --argjson size "$size" --arg at "$now" --arg obs "$STAGE_OBSERVED" \
    '{version: $v, previous: $p, backend: $be, bins: $bins, sizeBytes: $size, installedAt: $at, observed: (if $obs == "" then null else $obs end)}')"
  rm -rf "$AGENTBOX_DIR/stage/$$/$tool"
  dur=$(($(now_ms) - STEP_START))
  emit "$tool" relink ok version "$version" previous "$oldversion" backend "$backend" sizeBytes "$size" observed "$STAGE_OBSERVED" durationMs "$dur"
  CURRENT_TOOL=""
  log "$tool: relinked to $version"
}

do_remove() {
  local tool=$2 old backend n dur
  old=$(state_get "$tool")
  if [ -z "$old" ]; then
    dur=$(($(now_ms) - STEP_START))
    emit "$tool" remove skipped durationMs "$dur"
    CURRENT_TOOL=""
    return
  fi
  backend=$(jq -r '.backend' <<<"$old")
  while IFS= read -r n; do
    [ -n "$n" ] || continue
    rm -f "$BIN_DIR/$n"
  done < <(jq -r '.bins[]' <<<"$old")
  prune "$backend"
  state_del "$tool"
  dur=$(($(now_ms) - STEP_START))
  emit "$tool" remove ok backend "$backend" durationMs "$dur"
  CURRENT_TOOL=""
  log "$tool: removed"
}

do_verify() {
  local i=$1 tool=$2 name optional resolved out rc line="" first="" path="" missing="" old
  local -a vargs
  if [ "$(jq -r --argjson i "$i" '.steps[$i].registry // false' "$PLAN")" = true ]; then
    old=$(state_get "$tool")
    while IFS= read -r name; do
      [ -n "$name" ] || continue
      if [ -e "$BIN_DIR/$name" ]; then
        [ -n "$path" ] || path="$BIN_DIR/$name"
      else
        missing=$name
      fi
    done < <(jq -r '.bins[]?' <<<"${old:-null}" 2>/dev/null)
    if [ -z "$path" ] || [ -n "$missing" ]; then
      emit "$tool" verify skipped durationMs "$(($(now_ms) - STEP_START))"
    else
      emit "$tool" verify ok path "$path" durationMs "$(($(now_ms) - STEP_START))"
    fi
    CURRENT_TOOL=""
    return
  fi
  mapfile -t vargs < <(jq -r --argjson i "$i" '.steps[$i].versionArgs[]' "$PLAN")
  while IFS=$'\t' read -r name optional; do
    if ! resolved=$(command -v "$name" 2>/dev/null) || [ -z "$resolved" ]; then
      [ "$optional" = true ] || missing=$name
      continue
    fi
    if [ -z "$first" ]; then
      first=1
      path=$resolved
      if [ "${#vargs[@]}" -gt 0 ]; then
        out="$RUN_DIR/verify.out"
        timeout --foreground -k 2 "$SMOKE_TIMEOUT" "$resolved" "${vargs[@]}" >"$out" 2>&1 </dev/null
        rc=$?
        [ "$rc" -eq 0 ] && line=$(head -n 1 "$out" | tr -d '\000-\037' | cut -c1-200)
      fi
    fi
  done < <(jq -r --argjson i "$i" '.steps[$i].bins[] | [.name, (.optional // false | tostring)] | @tsv' "$PLAN")
  local dur=$(($(now_ms) - STEP_START))
  if [ -n "$missing" ] || [ -z "$first" ]; then
    # absent is not broken: the worker tells "not installed" (skipped) from "installed but failing" (failed)
    emit "$tool" verify skipped durationMs "$dur"
  elif [ "${#vargs[@]}" -gt 0 ] && [ -z "$line" ]; then
    emit "$tool" verify failed errorCode smoke_failed error "$path ${vargs[*]} failed" path "$path" durationMs "$dur"
    OVERALL=1
  else
    emit "$tool" verify ok observed "$line" path "$path" durationMs "$dur"
  fi
  CURRENT_TOOL=""
}

# --- main ----------------------------------------------------------------------------------------------
OVERALL=0
count=$(jq -r '.steps | length' "$PLAN")
log "toolchain run: mode=$MODE steps=$count"
for ((idx = 0; idx < count; idx++)); do
  IFS=$'\t' read -r tool action version < <(jq -r --argjson i "$idx" '.steps[$i] | [.tool, .action, (.version // "")] | @tsv' "$PLAN")
  CURRENT_TOOL=$tool
  CURRENT_ACTION=$action
  STEP_START=$(now_ms)
  if [ "$MODE" = check ] && [ "$action" != verify ]; then
    emit "$tool" "$action" skipped
    CURRENT_TOOL=""
    continue
  fi
  emit "$tool" "$action" running version "$version"
  case $action in
    install) do_install "$idx" "$tool" "$version" ;;
    relink) do_relink "$idx" "$tool" "$version" ;;
    remove) do_remove "$idx" "$tool" ;;
    verify) do_verify "$idx" "$tool" ;;
    *) finish_failed "$tool" "$action" install_failed "unknown action" ;;
  esac
done

[ "$MODE" = check ] || purge_cache
exit "$OVERALL"
