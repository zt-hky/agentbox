# ~/.profile: seeded by AgentBox on first start.
# PATH and mise/npm prefixes come from the image-owned /opt/agentbox/env.sh.
[ -r /opt/agentbox/env.sh ] && . /opt/agentbox/env.sh
if [ -n "${BASH_VERSION:-}" ] && [ -f "$HOME/.bashrc" ]; then
  . "$HOME/.bashrc"
fi
