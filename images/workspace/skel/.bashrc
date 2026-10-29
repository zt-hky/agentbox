# ~/.bashrc: seeded by AgentBox on first start.
PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
export PATH
case $- in
  *i*) ;;
  *) return ;;
esac
HISTCONTROL=ignoreboth
HISTSIZE=5000
shopt -s histappend checkwinsize
alias ll='ls -alF'
