# AgentBox workspace environment (envVersion 1). Image-owned: installed at
# /opt/agentbox/env.sh and sourced by workspace-init, /etc/profile.d/agentbox.sh,
# /etc/bash.bashrc and every toolchain run. POSIX sh; safe to source repeatedly.
[ -n "${HOME:-}" ] || return 0 2>/dev/null || exit 0

export MISE_DATA_DIR="$HOME/.local/share/mise"
export MISE_CACHE_DIR="$HOME/.cache/mise"
export NPM_CONFIG_PREFIX="$HOME/.npm-global"

# Drop our directories from PATH, then put them back in front in a fixed order.
_abx_rest=
_abx_old_ifs=$IFS
IFS=:
for _abx_d in $PATH; do
  case "$_abx_d" in
    "$HOME/.agentbox/bin" | "$HOME/.npm-global/bin" | "$HOME/.local/bin" | "") ;;
    *) _abx_rest="${_abx_rest:+$_abx_rest:}$_abx_d" ;;
  esac
done
IFS=$_abx_old_ifs
PATH="$HOME/.agentbox/bin:$HOME/.npm-global/bin:$HOME/.local/bin${_abx_rest:+:$_abx_rest}"
export PATH
unset _abx_rest _abx_old_ifs _abx_d
