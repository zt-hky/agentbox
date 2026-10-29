# ~/.profile: seeded by AgentBox on first start.
PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
export PATH
if [ -n "${BASH_VERSION:-}" ] && [ -f "$HOME/.bashrc" ]; then
  . "$HOME/.bashrc"
fi
