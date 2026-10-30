# Toolchain apply script: container spike

Transcript of `apps/agent/test/toolchain-spike.sh` (run with `SPIKE_EXTRA=1`), which drives
`apps/agent/src/toolchain/apply.sh` the way the host agent does: script and plan written with
`podman exec -i` stdin, then `bash apply.sh <run-dir>`, inside a throwaway rootless container
(`--userns=keep-id:uid=1000,gid=1000 --user 1000:1000 --cap-drop=ALL --security-opt=no-new-privileges`,
image `localhost/agentbox-workspace:dev`, `HOME=/workspace/home`, mise 2026.10.23 mounted read-only at
`/opt/spike`, `PATH=/opt/spike:/usr/bin:/bin` so no baked node/claude is used). Plans are generated with the
real `toAgentStep` and validated with `toolchainApplyRequestSchema`. Recorded 2026-10-30.

Findings that shaped the script:

- mise's `npm`/`npx` wrapper for Node locates its siblings from `dirname $BASH_SOURCE` without resolving
  symlinks, so a symlink in the farm breaks it. Shell-script bins get a tiny exec wrapper
  (`# agentbox-farm-wrapper`) instead of a symlink (`npm` below); everything else is a symlink.
- `aqua:earendil-works/pi` lays the binary out as `<dir>/pi/pi`; `locate_bin` also tries `<dir>/<file>/<file>`.
- The container's `timeout` is uutils coreutils; `date +%s%3N` is not portable there, so durations use
  `$EPOCHREALTIME`.
- mise leaves empty alias dirs (`1`, `1.4`, `latest`) after uninstall; they are not versions and are left alone.
- A tool that is absent reports `verify` status `skipped`; `failed` is only for a binary that exists but whose
  `--version` fails.

```text

## Environment

$ podman run ... localhost/agentbox-workspace:dev sleep infinity   # uid 1000, cap-drop=ALL, no-new-privileges, PATH=/opt/spike:/usr/bin:/bin
2026.10.23 linux-x64 (2026-10-29)
jq-1.8.1
flock from util-linux 2.41.3
timeout (uutils coreutils) 0.10.0
uid=1000(coder) gid=1000(coder) groups=1000(coder)
HOME=/workspace/home
(no baked node/claude/codex/omp on PATH)

## Resolve versions

node lts=26.13.0 python 3.12=3.12.16 bun=1.4.4 (old 1.3.0) claude=2.1.312 codex=0.163.0 omp=18.13.3 copilot=1.0.105

## Run 1: install node, python 3.12, bun 1.3.0, claude, codex, omp, copilot

$ bash ~/.agentbox/runs/run1/apply.sh ~/.agentbox/runs/run1   # steps: node|install|26.13.0 python|install|3.12.16 bun|install|1.3.0 claude|install|2.1.312 codex|install|0.163.0 omp|install|18.13.3 copilot|install|1.0.105
[04:38:06] toolchain run: mode=apply steps=7
[04:38:06] node: mise install node@26.13.0 (backend 1/1)
[04:38:10] optional bin corepack not found in /workspace/home/.local/share/mise/installs/node/26.13.0
[04:38:10] node: installed 26.13.0
[04:38:10] python: mise install python@3.12.16 (backend 1/1)
[04:38:15] python: installed 3.12.16
[04:38:15] bun: mise install bun@1.3.0 (backend 1/1)
[04:38:18] bun: installed 1.3.0
[04:38:18] claude: mise install aqua:anthropics/claude-code@2.1.312 (backend 1/2)
[04:38:26] claude: installed 2.1.312
[04:38:26] codex: mise install aqua:openai/codex@0.163.0 (backend 1/2)
[04:38:38] codex: installed 0.163.0
[04:38:38] omp: mise install github:can1357/oh-my-pi@18.13.3 (backend 1/2)
[04:38:54] omp: installed 18.13.3
[04:38:54] copilot: mise install aqua:github/copilot-cli@1.0.105 (backend 1/2)
[04:39:03] copilot: installed 1.0.105
# wall 57s

$ jq -c ".exitCode, (.steps[] | {tool,action,status,version,previous,backend,errorCode,sizeBytes,observed,path,durationMs})" result.json
0
{"tool":"node","action":"install","status":"ok","version":"26.13.0","backend":"node","sizeBytes":235896832,"observed":"v26.13.0","durationMs":4142}
{"tool":"python","action":"install","status":"ok","version":"3.12.16","backend":"python","sizeBytes":113045504,"observed":"Python 3.12.16","durationMs":5130}
{"tool":"bun","action":"install","status":"ok","version":"1.3.0","backend":"bun","sizeBytes":104906752,"observed":"1.3.0","durationMs":2728}
{"tool":"claude","action":"install","status":"ok","version":"2.1.312","backend":"aqua:anthropics/claude-code","sizeBytes":293593088,"observed":"2.1.312 (Claude Code)","durationMs":7772}
{"tool":"codex","action":"install","status":"ok","version":"0.163.0","backend":"aqua:openai/codex","sizeBytes":430030848,"observed":"codex-cli 0.163.0","durationMs":11817}
{"tool":"omp","action":"install","status":"ok","version":"18.13.3","backend":"github:can1357/oh-my-pi","sizeBytes":277135360,"observed":"omp/18.13.3","durationMs":16222}
{"tool":"copilot","action":"install","status":"ok","version":"1.0.105","backend":"aqua:github/copilot-cli","sizeBytes":198512640,"observed":"GitHub Copilot CLI 1.0.105.","durationMs":9195}
# run exit code: 0

## Run 2: pi, opencode, grok, muse

pi=1.4.0 opencode=2.2.1 grok=1.0.70 muse=1.4.14-R7309.1
$ bash ~/.agentbox/runs/run2/apply.sh ~/.agentbox/runs/run2   # steps: pi|install|1.4.0 opencode|install|2.2.1 grok|install|1.0.70 muse|install|1.4.14-R7309.1|https://lookaside.facebook.com/lookaside/muse/download/?channel=muse&version=1.4.14-R7309.1&file=muse-x86-linux|sha256:0809aac7cb58d18f5022b6d05e02aa1974683c0ec430e5f04d25b60ed17de2da
[04:39:08] toolchain run: mode=apply steps=4
[04:39:08] pi: mise install aqua:earendil-works/pi@1.4.0 (backend 1/2)
[04:39:12] pi: installed 1.4.0
[04:39:12] opencode: mise install aqua:anomalyco/opencode@2.2.1 (backend 1/2)
[04:39:18] opencode: installed 2.2.1
[04:39:18] grok: mise install npm:@xai-official/grok@1.0.70 (backend 1/1)
[04:39:23] grok: installed 1.0.70
[04:39:23] muse: mise install http:muse@1.4.14-R7309.1 (backend 1/1)
[04:39:43] muse: installed 1.4.14-R7309.1
# wall 35s

$ jq -c ".exitCode, (.steps[] | {tool,action,status,version,previous,backend,errorCode,sizeBytes,observed,path,durationMs})" result.json
0
{"tool":"pi","action":"install","status":"ok","version":"1.4.0","backend":"aqua:earendil-works/pi","sizeBytes":115052544,"observed":"1.4.0","durationMs":4146}
{"tool":"opencode","action":"install","status":"ok","version":"2.2.1","backend":"aqua:anomalyco/opencode","sizeBytes":246878208,"observed":"opencode v2.2.1","durationMs":5635}
{"tool":"grok","action":"install","status":"ok","version":"1.0.70","backend":"npm:@xai-official/grok","sizeBytes":55767040,"observed":"grok 1.0.70 (f50904eaee6c)","durationMs":4915}
{"tool":"muse","action":"install","status":"ok","version":"1.4.14-R7309.1","backend":"http:muse","sizeBytes":414928896,"observed":"Muse Code 1.4.14 (1.4.14-R7309.1)","durationMs":19907}
# run exit code: 0

## Farm symlinks and --version through the farm PATH

$ ls -l ~/.agentbox/bin
bun -> /workspace/home/.local/share/mise/installs/bun/1.3.0/bin/bun
bunx -> /workspace/home/.local/share/mise/installs/bun/1.3.0/bin/bunx
claude -> /workspace/home/.local/share/mise/installs/aqua-anthropics-claude-code/2.1.312/claude
codex -> /workspace/home/.local/share/mise/installs/aqua-openai-codex/0.163.0/bin/codex
copilot -> /workspace/home/.local/share/mise/installs/aqua-github-copilot-cli/1.0.105/copilot
grok
muse -> /workspace/home/.local/share/mise/installs/http-muse/1.4.14-R7309.1/download
node -> /workspace/home/.local/share/mise/installs/node/26.13.0/bin/node
npm
npx -> /workspace/home/.local/share/mise/installs/node/26.13.0/bin/npx
omp -> /workspace/home/.local/share/mise/installs/github-can1357-oh-my-pi/18.13.3/omp
opencode -> /workspace/home/.local/share/mise/installs/aqua-anomalyco-opencode/2.2.1/opencode
pi -> /workspace/home/.local/share/mise/installs/aqua-earendil-works-pi/1.4.0/pi/pi
pip
pip3
python -> /workspace/home/.local/share/mise/installs/python/3.12.16/bin/python
python3 -> /workspace/home/.local/share/mise/installs/python/3.12.16/bin/python3

$ PATH=~/.agentbox/bin:/opt/spike:/usr/bin:/bin; <bin> --version
node      ~/.local/share/mise/installs/node/26.13.0/bin/node -> v26.13.0
npm       ~/.agentbox/bin/npm -> 11.20.0
npx       ~/.local/share/mise/installs/node/26.13.0/lib/node_modules/npm/bin/npx-cli.js -> 11.20.0
python    ~/.local/share/mise/installs/python/3.12.16/bin/python3.12 -> Python 3.12.16
python3   ~/.local/share/mise/installs/python/3.12.16/bin/python3.12 -> Python 3.12.16
pip       ~/.agentbox/bin/pip -> pip 26.2.2 from /workspace/home/.local/share/mise/installs/python/3.12
bun       ~/.local/share/mise/installs/bun/1.3.0/bin/bun -> 1.3.0
bunx      ~/.local/share/mise/installs/bun/1.3.0/bin/bun -> 1.3.0
claude    ~/.local/share/mise/installs/aqua-anthropics-claude-code/2.1.312/claude -> 2.1.312 (Claude Code)
codex     ~/.local/share/mise/installs/aqua-openai-codex/0.163.0/bin/codex -> codex-cli 0.163.0
omp       ~/.local/share/mise/installs/github-can1357-oh-my-pi/18.13.3/omp -> omp/18.13.3
copilot   ~/.local/share/mise/installs/aqua-github-copilot-cli/1.0.105/copilot -> GitHub Copilot CLI 1.0.105.
pi        ~/.local/share/mise/installs/aqua-earendil-works-pi/1.4.0/pi/pi -> 1.4.0
opencode  ~/.local/share/mise/installs/aqua-anomalyco-opencode/2.2.1/opencode -> opencode v2.2.1
grok      ~/.agentbox/bin/grok -> grok 1.0.70 (f50904eaee6c)
muse      ~/.local/share/mise/installs/http-muse/1.4.14-R7309.1/download -> Muse Code 1.4.14 (1.4.14-R7309.1)

$ cat ~/.agentbox/toolchain.json | jq -c ".tools | to_entries[] | {id: .key} + .value"
{"id":"node","version":"26.13.0","previous":null,"backend":"node","bins":["node","npm","npx"],"sizeBytes":235896832,"installedAt":"2026-10-30T04:38:10Z","observed":"v26.13.0"}
{"id":"python","version":"3.12.16","previous":null,"backend":"python","bins":["python","python3","pip","pip3"],"sizeBytes":113045504,"installedAt":"2026-10-30T04:38:15Z","observed":"Python 3.12.16"}
{"id":"bun","version":"1.3.0","previous":null,"backend":"bun","bins":["bun","bunx"],"sizeBytes":104906752,"installedAt":"2026-10-30T04:38:18Z","observed":"1.3.0"}
{"id":"claude","version":"2.1.312","previous":null,"backend":"aqua:anthropics/claude-code","bins":["claude"],"sizeBytes":293593088,"installedAt":"2026-10-30T04:38:26Z","observed":"2.1.312 (Claude Code)"}
{"id":"codex","version":"0.163.0","previous":null,"backend":"aqua:openai/codex","bins":["codex"],"sizeBytes":430030848,"installedAt":"2026-10-30T04:38:38Z","observed":"codex-cli 0.163.0"}
{"id":"omp","version":"18.13.3","previous":null,"backend":"github:can1357/oh-my-pi","bins":["omp"],"sizeBytes":277135360,"installedAt":"2026-10-30T04:38:54Z","observed":"omp/18.13.3"}
{"id":"copilot","version":"1.0.105","previous":null,"backend":"aqua:github/copilot-cli","bins":["copilot"],"sizeBytes":198512640,"installedAt":"2026-10-30T04:39:03Z","observed":"GitHub Copilot CLI 1.0.105."}
{"id":"pi","version":"1.4.0","previous":null,"backend":"aqua:earendil-works/pi","bins":["pi"],"sizeBytes":115052544,"installedAt":"2026-10-30T04:39:12Z","observed":"1.4.0"}
{"id":"opencode","version":"2.2.1","previous":null,"backend":"aqua:anomalyco/opencode","bins":["opencode"],"sizeBytes":246878208,"installedAt":"2026-10-30T04:39:18Z","observed":"opencode v2.2.1"}
{"id":"grok","version":"1.0.70","previous":null,"backend":"npm:@xai-official/grok","bins":["grok"],"sizeBytes":55767040,"installedAt":"2026-10-30T04:39:23Z","observed":"grok 1.0.70 (f50904eaee6c)"}
{"id":"muse","version":"1.4.14-R7309.1","previous":null,"backend":"http:muse","bins":["muse"],"sizeBytes":414928896,"installedAt":"2026-10-30T04:39:43Z","observed":"Muse Code 1.4.14 (1.4.14-R7309.1)"}
$ du -sh ~/.local/share/mise/installs/*   # kept versions only
0	~/.local/share/mise/installs/aqua-anomalyco-opencode/2
0	~/.local/share/mise/installs/aqua-anomalyco-opencode/2.2
236M	~/.local/share/mise/installs/aqua-anomalyco-opencode/2.2.1
0	~/.local/share/mise/installs/aqua-anomalyco-opencode/latest
0	~/.local/share/mise/installs/aqua-anthropics-claude-code/2
0	~/.local/share/mise/installs/aqua-anthropics-claude-code/2.1
280M	~/.local/share/mise/installs/aqua-anthropics-claude-code/2.1.312
0	~/.local/share/mise/installs/aqua-anthropics-claude-code/latest
0	~/.local/share/mise/installs/aqua-earendil-works-pi/1
0	~/.local/share/mise/installs/aqua-earendil-works-pi/1.4
110M	~/.local/share/mise/installs/aqua-earendil-works-pi/1.4.0
0	~/.local/share/mise/installs/aqua-earendil-works-pi/latest
0	~/.local/share/mise/installs/aqua-github-copilot-cli/1
0	~/.local/share/mise/installs/aqua-github-copilot-cli/1.0
190M	~/.local/share/mise/installs/aqua-github-copilot-cli/1.0.105
0	~/.local/share/mise/installs/aqua-github-copilot-cli/latest
0	~/.local/share/mise/installs/aqua-openai-codex/0
0	~/.local/share/mise/installs/aqua-openai-codex/0.163
411M	~/.local/share/mise/installs/aqua-openai-codex/0.163.0
0	~/.local/share/mise/installs/aqua-openai-codex/latest
0	~/.local/share/mise/installs/bun/1
0	~/.local/share/mise/installs/bun/1.3
101M	~/.local/share/mise/installs/bun/1.3.0
0	~/.local/share/mise/installs/bun/latest
0	~/.local/share/mise/installs/github-can1357-oh-my-pi/18
0	~/.local/share/mise/installs/github-can1357-oh-my-pi/18.13
265M	~/.local/share/mise/installs/github-can1357-oh-my-pi/18.13.3
0	~/.local/share/mise/installs/github-can1357-oh-my-pi/latest
0	~/.local/share/mise/installs/http-muse/1
0	~/.local/share/mise/installs/http-muse/1.4
396M	~/.local/share/mise/installs/http-muse/1.4.14-R7309.1
0	~/.local/share/mise/installs/http-muse/latest
0	~/.local/share/mise/installs/node/26
0	~/.local/share/mise/installs/node/26.13
225M	~/.local/share/mise/installs/node/26.13.0
0	~/.local/share/mise/installs/node/latest
0	~/.local/share/mise/installs/node/lts
0	~/.local/share/mise/installs/node/lts-lithium
0	~/.local/share/mise/installs/npm-xai-official-grok/1
0	~/.local/share/mise/installs/npm-xai-official-grok/1.0
54M	~/.local/share/mise/installs/npm-xai-official-grok/1.0.70
0	~/.local/share/mise/installs/npm-xai-official-grok/latest
0	~/.local/share/mise/installs/python/3
0	~/.local/share/mise/installs/python/3.12
108M	~/.local/share/mise/installs/python/3.12.16
0	~/.local/share/mise/installs/python/latest
$ ls ~/.cache/mise | wc -l   # cache purged
0

## Run 3: upgrade bun 1.3.0 -> 1.4.4 (keeps previous)

$ bash ~/.agentbox/runs/run3/apply.sh ~/.agentbox/runs/run3   # steps: bun|install|1.4.4
[04:39:46] toolchain run: mode=apply steps=1
[04:39:46] bun: mise install bun@1.4.4 (backend 1/1)
[04:39:50] bun: installed 1.4.4
# wall 4s

$ jq -c ".exitCode, (.steps[] | {tool,action,status,version,previous,backend,errorCode,sizeBytes,observed,path,durationMs})" result.json
0
{"tool":"bun","action":"install","status":"ok","version":"1.4.4","previous":"1.3.0","backend":"bun","sizeBytes":107311104,"observed":"1.4.4","durationMs":4385}
bun -> ~/.local/share/mise/installs/bun/1.4.4/bin/bun : 1.4.4
$ jq -c .tools.bun toolchain.json
{"version":"1.4.4","previous":"1.3.0","backend":"bun","bins":["bun","bunx"],"sizeBytes":107311104,"installedAt":"2026-10-30T04:39:50Z","observed":"1.4.4"}
$ ls ~/.local/share/mise/installs/bun
1
1.3
1.3.0
1.4
1.4.4
latest

## Run 4: relink (rollback) bun to 1.3.0

$ bash ~/.agentbox/runs/run4/apply.sh ~/.agentbox/runs/run4   # steps: bun|relink|1.3.0
[04:39:51] toolchain run: mode=apply steps=1
[04:39:52] bun: relinked to 1.3.0
# wall 1s

$ jq -c ".exitCode, (.steps[] | {tool,action,status,version,previous,backend,errorCode,sizeBytes,observed,path,durationMs})" result.json
0
{"tool":"bun","action":"relink","status":"ok","version":"1.3.0","previous":"1.4.4","backend":"bun","sizeBytes":104906752,"observed":"1.3.0","durationMs":70}
bun -> ~/.local/share/mise/installs/bun/1.3.0/bin/bun : 1.3.0
{"version":"1.3.0","previous":"1.4.4"}
# rollback again to a version that is not kept (must fail with no_previous, links untouched)
$ bash ~/.agentbox/runs/run4b/apply.sh ~/.agentbox/runs/run4b   # steps: bun|relink|0.0.1
[04:39:53] toolchain run: mode=apply steps=1
# wall 0s

$ jq -c ".exitCode, (.steps[] | {tool,action,status,version,previous,backend,errorCode,sizeBytes,observed,path,durationMs})" result.json
1
{"tool":"bun","action":"relink","status":"failed","backend":"bun","errorCode":"no_previous","error":"no kept previous version 0.0.1","durationMs":13}
bun still: 1.3.0

## Run 5: failed install (nonexistent version) leaves old links untouched

$ bash ~/.agentbox/runs/run5/apply.sh ~/.agentbox/runs/run5   # steps: bun|install|9.9.9 node|install|26.13.0
[04:39:54] toolchain run: mode=apply steps=2
[04:39:54] bun: mise install bun@9.9.9 (backend 1/1)
mise ERROR Failed to install core:bun@9.9.9: HTTP status client error (404 Not Found) for url (https://github.com/oven-sh/bun/releases/download/bun-v9.9.9/bun-linux-x64.zip)
mise ERROR Version: 2026.10.23 linux-x64 (2026-10-29)
mise ERROR Run with --verbose or MISE_VERBOSE=1 for more information
[04:39:55] bun: mise install bun@9.9.9 failed (exit 1): mise ERROR Failed to install core:bun@9.9.9: HTTP status client error (404 Not Found) for url (https://github.com/oven-sh/bun/releases/download/bun-v9.9.9/bun-linux
[04:39:55] bun: removing partial install bun@9.9.9
[04:39:55] node: mise install node@26.13.0 (backend 1/1)
[04:39:56] optional bin corepack not found in /workspace/home/.local/share/mise/installs/node/26.13.0
[04:39:56] node: installed 26.13.0
# wall 2s

$ jq -c ".exitCode, (.steps[] | {tool,action,status,version,previous,backend,errorCode,sizeBytes,observed,path,durationMs})" result.json
1
{"tool":"bun","action":"install","status":"failed","errorCode":"version_not_found","error":"mise install bun@9.9.9 failed (exit 1): mise ERROR Failed to install core:bun@9.9.9: HTTP status client error (404 Not Found) for url (https://github.com/oven-sh/bun/releases/download/bun-v9.9.9/bun-linux-x64.zip) mise ERROR Version: 2026.10.23 linux-x64 (2026-10-29) mise ERROR Run with --verbose or MISE_VERBOSE=1 for more information ","durationMs":1002}
{"tool":"node","action":"install","status":"ok","version":"26.13.0","backend":"node","sizeBytes":235896832,"observed":"v26.13.0","durationMs":872}
# exit code 1 (bun failed, node step still ran)
bun still: ~/.local/share/mise/installs/bun/1.3.0/bin/bun : 1.3.0
$ ls ~/.local/share/mise/installs/bun   # no 9.9.9 left behind
1
1.3
1.3.0
1.4
1.4.4
latest

## Run 6: verify (check mode, read-only)

$ bash ~/.agentbox/runs/run6/apply.sh ~/.agentbox/runs/run6   # steps: node|verify bun|verify claude|verify opencode|verify
[04:39:57] toolchain run: mode=check steps=4
# wall 0s

$ jq -c ".exitCode, (.steps[] | {tool,action,status,version,previous,backend,errorCode,sizeBytes,observed,path,durationMs})" result.json
0
{"tool":"node","action":"verify","status":"ok","observed":"v26.13.0","path":"/workspace/home/.agentbox/bin/node","durationMs":18}
{"tool":"bun","action":"verify","status":"ok","observed":"1.3.0","path":"/workspace/home/.agentbox/bin/bun","durationMs":16}
{"tool":"claude","action":"verify","status":"ok","observed":"2.1.312 (Claude Code)","path":"/workspace/home/.agentbox/bin/claude","durationMs":20}
{"tool":"opencode","action":"verify","status":"ok","observed":"opencode v2.2.1","path":"/workspace/home/.agentbox/bin/opencode","durationMs":76}
# a tool that is not installed reports skipped (absent), never failed

## Run 7: concurrent run is refused (flock, exit 75)

[04:39:58] another toolchain run holds /workspace/home/.agentbox/run.lock
exit=75

## Run 8: remove

$ bash ~/.agentbox/runs/run8/apply.sh ~/.agentbox/runs/run8   # steps: bun|remove node|remove
[04:39:58] toolchain run: mode=apply steps=2
[04:39:59] uninstalling bun@1.3.0
[04:39:59] uninstalling bun@1.4.4
[04:39:59] bun: removed
[04:39:59] uninstalling node@26.13.0
[04:39:59] node: removed
# wall 1s

$ jq -c ".exitCode, (.steps[] | {tool,action,status,version,previous,backend,errorCode,sizeBytes,observed,path,durationMs})" result.json
0
{"tool":"bun","action":"remove","status":"ok","backend":"bun","durationMs":74}
{"tool":"node","action":"remove","status":"ok","backend":"node","durationMs":72}
$ ls -l ~/.agentbox/bin
claude -> /workspace/home/.local/share/mise/installs/aqua-anthropics-claude-code/2.1.312/claude
codex -> /workspace/home/.local/share/mise/installs/aqua-openai-codex/0.163.0/bin/codex
copilot -> /workspace/home/.local/share/mise/installs/aqua-github-copilot-cli/1.0.105/copilot
grok
muse -> /workspace/home/.local/share/mise/installs/http-muse/1.4.14-R7309.1/download
omp -> /workspace/home/.local/share/mise/installs/github-can1357-oh-my-pi/18.13.3/omp
opencode -> /workspace/home/.local/share/mise/installs/aqua-anomalyco-opencode/2.2.1/opencode
pi -> /workspace/home/.local/share/mise/installs/aqua-earendil-works-pi/1.4.0/pi/pi
pip
pip3
python -> /workspace/home/.local/share/mise/installs/python/3.12.16/bin/python
python3 -> /workspace/home/.local/share/mise/installs/python/3.12.16/bin/python3
["claude","codex","copilot","grok","muse","omp","opencode","pi","python"]
$ ls ~/.local/share/mise/installs
aqua-anomalyco-opencode
aqua-anthropics-claude-code
aqua-earendil-works-pi
aqua-github-copilot-cli
aqua-openai-codex
github-can1357-oh-my-pi
http-muse
npm-xai-official-grok
python

## Run 9: verify after remove (absent tool is skipped, not failed)

$ bash ~/.agentbox/runs/run9/apply.sh ~/.agentbox/runs/run9   # steps: node|verify python|verify
[04:40:00] toolchain run: mode=check steps=2
# wall 0s

$ jq -c ".exitCode, (.steps[] | {tool,action,status,version,previous,backend,errorCode,sizeBytes,observed,path,durationMs})" result.json
0
{"tool":"node","action":"verify","status":"skipped","durationMs":10}
{"tool":"python","action":"verify","status":"ok","observed":"Python 3.12.16","path":"/workspace/home/.agentbox/bin/python","durationMs":17}
```
