#!/usr/bin/env bash
# Create missing control-plane secrets as abx-cp. Idempotent; never overwrites, never prints values.
#
# podman secrets (type=env in the quadlets): better_auth_secret, encryption_key, postgres_password,
#   database_url, agent_token (copied from /etc/agentbox/agent.env), cloudflared_token (only when
#   CLOUDFLARED_TOKEN is set).
# Optional values go to $CP_HOME/optional.env (0600 abx-cp, always present, may be empty), loaded by
# the web container: GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET
#   GITHUB_CONNECT_CLIENT_ID GITHUB_CONNECT_CLIENT_SECRET AGENTBOX_BOOTSTRAP_ADMIN_EMAILS.
# Pass them through sudo, e.g.: sudo --preserve-env=GOOGLE_CLIENT_ID,GOOGLE_CLIENT_SECRET bash secrets.sh
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$here/lib.sh"
umask 077
ensure_cp_manager

create_secret() { # name  (value on stdin)
  abxcp podman secret create "$1" - >/dev/null
  echo "created secret $1"
}

gen_secret() { # name  generator-command...
  local name=$1; shift
  if secret_exists "$name"; then echo "secret $name exists"; return; fi
  "$@" | tr -d '\n' | create_secret "$name"
}

gen_secret better_auth_secret openssl rand -hex 32
gen_secret encryption_key openssl rand -base64 32
gen_secret postgres_password openssl rand -hex 24

if ! secret_exists database_url; then
  pw=$(abxcp podman secret inspect --showsecret --format '{{.SecretData}}' postgres_password)
  printf 'postgres://agentbox:%s@127.0.0.1:5432/agentbox' "$pw" | create_secret database_url
  unset pw
else
  echo "secret database_url exists"
fi

if ! secret_exists agent_token; then
  [ -r /etc/agentbox/agent.env ] || { echo "/etc/agentbox/agent.env missing: run infra/host/provision.sh first" >&2; exit 1; }
  tok=$(sed -n 's/^AGENTBOX_AGENT_TOKEN=//p' /etc/agentbox/agent.env | head -n1)
  [ -n "$tok" ] || { echo "AGENTBOX_AGENT_TOKEN not found in /etc/agentbox/agent.env" >&2; exit 1; }
  printf '%s' "$tok" | create_secret agent_token
  unset tok
else
  echo "secret agent_token exists"
fi

if [ -n "${CLOUDFLARED_TOKEN:-}" ]; then
  if secret_exists cloudflared_token; then
    abxcp podman secret rm cloudflared_token >/dev/null
  fi
  printf '%s' "$CLOUDFLARED_TOKEN" | create_secret cloudflared_token
else
  secret_exists cloudflared_token && echo "secret cloudflared_token exists" || echo "cloudflared_token not provided (tunnel stays disabled)"
fi

# optional.env: keep existing values, override with any provided in the environment.
opt=$CP_HOME/optional.env
keys=(GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET
      GITHUB_CONNECT_CLIENT_ID GITHUB_CONNECT_CLIENT_SECRET AGENTBOX_BOOTSTRAP_ADMIN_EMAILS)
declare -A val
if [ -f "$opt" ]; then
  while IFS= read -r line; do
    case "$line" in ''|\#*) continue ;; esac
    val[${line%%=*}]=${line#*=}
  done < "$opt"
fi
for k in "${keys[@]}"; do
  if [ -n "${!k:-}" ]; then
    case "${!k}" in *$'\n'*) echo "$k contains a newline" >&2; exit 1 ;; esac
    val[$k]=${!k}
    echo "optional $k set"
  fi
done
tmp=$(mktemp "$CP_HOME/.optional.XXXXXX")
for k in "${keys[@]}"; do
  [ -n "${val[$k]:-}" ] && printf '%s=%s\n' "$k" "${val[$k]}" >> "$tmp"
done
chown "$CP_USER:$CP_USER" "$tmp"
chmod 0600 "$tmp"
mv "$tmp" "$opt"
echo "optional.env written ($(wc -l < "$opt") entries)"
