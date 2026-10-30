# ~/.bashrc: seeded by AgentBox on first start.
# PATH and mise/npm prefixes come from the image-owned /opt/agentbox/env.sh.
[ -r /opt/agentbox/env.sh ] && . /opt/agentbox/env.sh
case $- in
  *i*) ;;
  *) return ;;
esac
HISTCONTROL=ignoreboth
HISTSIZE=5000
shopt -s histappend checkwinsize
alias ll='ls -alF'
