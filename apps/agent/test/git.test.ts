import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { GitConnectionSpec, PutGitRequest } from "@agentbox/core/agent-api";
import { PINNED_SSH_HOST_KEYS } from "@agentbox/core/git";
import type { ContainerExec } from "../src/accounts.ts";
import { run } from "../src/exec.ts";
import {
  BLOCK_END,
  BLOCK_START,
  mergeManagedBlock,
  reconcileGit,
  renderCredentialStore,
  renderKnownHostsBlock,
  renderSshConfigBlock,
  validateGitRequest,
} from "../src/git.ts";

const gh: GitConnectionSpec = {
  provider: "github",
  host: "github.com",
  login: "octo",
  token: "gho_secret",
  username: "octo",
};
const gl: GitConnectionSpec = {
  provider: "gitlab",
  host: "gitlab.com",
  login: "lab",
  token: "glpat/+ tok",
  username: "oauth2",
};
const SELF_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAfuCHKVTjquxvt6CM6tdG4SLp1Btn/nOeHHE5UOzRdf";
const self: GitConnectionSpec = {
  provider: "gitea",
  host: "git.example.com",
  login: "me",
  token: "tok",
  username: "me",
  knownHosts: `git.example.com ${SELF_KEY}`,
};
const generic: GitConnectionSpec = {
  provider: "generic",
  host: "code.example.org",
  login: "me",
  token: "app-pass",
  username: "me",
};

describe("renderers", () => {
  it("credential store holds every non-github connection, percent-encoded", () => {
    expect(renderCredentialStore([gh, gl, self])).toBe(
      "https://oauth2:glpat%2F%2B%20tok@gitlab.com\nhttps://me:tok@git.example.com\n",
    );
    expect(renderCredentialStore([gh])).toBe("");
  });

  it("ssh config has a Host block per connection, trust-on-first-use only without keys", () => {
    const block = renderSshConfigBlock([gh, self, generic])!;
    expect(block).toContain(
      "Host github.com\n  HostName github.com\n  User git\n  IdentityFile ~/.ssh/agentbox_ed25519\n  IdentitiesOnly yes",
    );
    const sections = block.split("\n\n");
    expect(sections[0]).not.toContain("StrictHostKeyChecking");
    expect(sections[1]).not.toContain("StrictHostKeyChecking");
    expect(sections[2]).toContain("Host code.example.org");
    expect(sections[2]).toContain("StrictHostKeyChecking accept-new");
    expect(renderSshConfigBlock([])).toBeNull();
  });

  it("known_hosts pins shipped keys for the big three and writes scans as-is", () => {
    const text = renderKnownHostsBlock([gh, gl, self, generic])!;
    for (const k of PINNED_SSH_HOST_KEYS["github.com"]!) expect(text).toContain(`github.com ${k}`);
    for (const k of PINNED_SSH_HOST_KEYS["gitlab.com"]!) expect(text).toContain(`gitlab.com ${k}`);
    expect(text).toContain(`git.example.com ${SELF_KEY}`);
    expect(text).not.toContain("code.example.org");
    expect(renderKnownHostsBlock([generic])).toBeNull();
  });
});

describe("mergeManagedBlock", () => {
  it("adds a block after user content and replaces it in place", () => {
    const user = "Host mine\n  User me\n";
    const once = mergeManagedBlock(user, "Host a");
    expect(once).toBe(`Host mine\n  User me\n\n${BLOCK_START}\nHost a\n${BLOCK_END}\n`);
    const twice = mergeManagedBlock(`${once}\nHost after\n  User x\n`, "Host b");
    expect(twice).toBe(
      `Host mine\n  User me\n\n${BLOCK_START}\nHost b\n${BLOCK_END}\n\nHost after\n  User x\n`,
    );
    expect(mergeManagedBlock(twice, "Host b")).toBe(twice);
  });

  it("removes the block and leaves user content; empty file when nothing else", () => {
    const withBlock = mergeManagedBlock("Host mine\n", "Host a");
    expect(mergeManagedBlock(withBlock, null)).toBe("Host mine\n");
    expect(mergeManagedBlock(mergeManagedBlock("", "Host a"), null)).toBe("");
    expect(mergeManagedBlock("", null)).toBe("");
  });

  it("an unterminated block runs to the end of the file", () => {
    expect(mergeManagedBlock(`keep\n${BLOCK_START}\nold\n`, "new")).toBe(
      `keep\n\n${BLOCK_START}\nnew\n${BLOCK_END}\n`,
    );
  });
});

describe("validateGitRequest", () => {
  const req = (c: Partial<GitConnectionSpec>[]): PutGitRequest => ({
    connections: c.map((x) => ({ ...gl, ...x })),
  });
  it("accepts a normal request", () => {
    expect(() => validateGitRequest({ connections: [gh, gl, self, generic] })).not.toThrow();
  });
  it.each([
    ["a host with a path", req([{ host: "evil.com/x" }])],
    ["localhost", req([{ host: "localhost" }])],
    ["an IP literal", req([{ host: "10.0.0.1" }])],
    ["duplicate hosts", req([{}, {}])],
    ["a token with a newline", req([{ token: "a\nb" }])],
    ["an option-like username", req([{ username: "-oProxyCommand=x" }])],
    [
      "known_hosts for another host",
      req([{ host: "git.example.com", knownHosts: `github.com ${SELF_KEY}` }]),
    ],
    [
      "known_hosts with config injection",
      req([{ host: "git.example.com", knownHosts: `git.example.com ${SELF_KEY}\nHost *` }]),
    ],
  ])("rejects %s", (_n, r) => {
    expect(() => validateGitRequest(r)).toThrow(/invalid|duplicate/);
  });
});

// ---- reconcile against a real HOME with real ssh-keygen, bash and git (only `gh` is faked) ----

describe("reconcileGit", () => {
  let home: string;
  let saved: Record<string, string | undefined>;
  let ghCalls: { args: string[]; input?: string }[];
  const exec: ContainerExec = async (args, opts) => {
    if (args[0] === "gh") {
      ghCalls.push({ args, input: opts?.input });
      return { code: 0, stdout: "", stderr: "" };
    }
    return run(args[0]!, args.slice(1), {
      input: opts?.input,
      check: opts?.check,
      redact: opts?.redact,
    });
  };
  const file = (rel: string) => path.join(home, rel);
  const read = (rel: string) => readFileSync(file(rel), "utf8");
  const git = async (...a: string[]) =>
    (await run("git", ["config", "--global", ...a], { check: false })).stdout.trim();

  beforeAll(() => {
    saved = {
      HOME: process.env.HOME,
      GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    };
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "abx-git-"));
    process.env.HOME = home;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    ghCalls = [];
    return () => rmSync(home, { recursive: true, force: true });
  });

  it("generates the workspace key once and keeps returning it", async () => {
    const a = await reconcileGit(exec, "alice", { connections: [] });
    expect(a.sshPublicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+ agentbox:alice$/);
    const privKey = read(".ssh/agentbox_ed25519");
    const b = await reconcileGit(exec, "alice", { connections: [] });
    expect(b.sshPublicKey).toBe(a.sshPublicKey);
    expect(read(".ssh/agentbox_ed25519")).toBe(privKey);
    expect(statSync(file(".ssh/agentbox_ed25519")).mode & 0o777).toBe(0o600);
    expect(statSync(file(".ssh")).mode & 0o777).toBe(0o700);
  });

  it("restores the public half from the private key when only that was lost", async () => {
    const a = await reconcileGit(exec, "alice", { connections: [] });
    rmSync(file(".ssh/agentbox_ed25519.pub"));
    const b = await reconcileGit(exec, "alice", { connections: [] });
    expect(b.sshPublicKey.split(" ").slice(0, 2)).toEqual(a.sshPublicKey.split(" ").slice(0, 2));
  });

  it("writes credentials, helpers, ssh config, known_hosts and logs gh in", async () => {
    await reconcileGit(exec, "alice", {
      connections: [gh, gl, self],
      identity: { name: "octo", email: "1+octo@users.noreply.github.com" },
    });
    const creds = read(".agentbox/git-credentials");
    expect(creds).toBe(
      "https://oauth2:glpat%2F%2B%20tok@gitlab.com\nhttps://me:tok@git.example.com\n",
    );
    expect(statSync(file(".agentbox/git-credentials")).mode & 0o777).toBe(0o600);
    const helper = `store --file ${home}/.agentbox/git-credentials`;
    expect(await git("--get", "credential.https://gitlab.com.helper")).toBe(helper);
    expect(await git("--get", "credential.https://git.example.com.helper")).toBe(helper);
    expect(await git("--get-all", "credential.https://github.com.helper")).toBe("");
    const cfg = read(".ssh/config");
    expect(cfg).toContain(BLOCK_START);
    for (const h of ["github.com", "gitlab.com", "git.example.com"])
      expect(cfg).toContain(`Host ${h}\n`);
    const kh = read(".ssh/known_hosts");
    expect(kh).toContain(`github.com ${PINNED_SSH_HOST_KEYS["github.com"]![0]}`);
    expect(kh).toContain(`git.example.com ${SELF_KEY}`);
    expect(ghCalls.map((c) => c.args.slice(1, 3).join(" "))).toEqual([
      "auth login",
      "auth setup-git",
    ]);
    expect(ghCalls[0]!.input).toBe("gho_secret\n");
    expect(await git("--get", "user.name")).toBe("octo");
    expect(await git("--get", "user.email")).toBe("1+octo@users.noreply.github.com");
  });

  it("is idempotent", async () => {
    const req: PutGitRequest = { connections: [gh, gl, self] };
    await reconcileGit(exec, "alice", req);
    const snapshot = [
      ".ssh/config",
      ".ssh/known_hosts",
      ".agentbox/git-credentials",
      ".gitconfig",
    ].map(read);
    await reconcileGit(exec, "alice", req);
    expect(
      [".ssh/config", ".ssh/known_hosts", ".agentbox/git-credentials", ".gitconfig"].map(read),
    ).toEqual(snapshot);
  });

  it("preserves user content in ssh config, known_hosts and git config", async () => {
    mkdirSync(file(".ssh"), { recursive: true });
    writeFileSync(file(".ssh/config"), "Host mine\n  User me\n");
    writeFileSync(file(".ssh/known_hosts"), "mine.example.com ssh-ed25519 AAAA\n");
    await run("git", ["config", "--global", "credential.https://git.example.com.helper", "cache"]);
    await reconcileGit(exec, "alice", { connections: [self] });
    expect(read(".ssh/config").startsWith("Host mine\n  User me\n")).toBe(true);
    expect(read(".ssh/known_hosts").startsWith("mine.example.com ssh-ed25519 AAAA\n")).toBe(true);
    expect(await git("--get-all", "credential.https://git.example.com.helper")).toContain("cache");
    await reconcileGit(exec, "alice", { connections: [] });
    expect(read(".ssh/config")).toBe("Host mine\n  User me\n");
    expect(read(".ssh/known_hosts")).toBe("mine.example.com ssh-ed25519 AAAA\n");
    expect(await git("--get-all", "credential.https://git.example.com.helper")).toBe("cache");
  });

  it("removing a connection drops its credentials, helper and host block, and gh logs out without github", async () => {
    await reconcileGit(exec, "alice", { connections: [gh, gl, self] });
    ghCalls = [];
    await reconcileGit(exec, "alice", { connections: [self] });
    expect(read(".agentbox/git-credentials")).toBe("https://me:tok@git.example.com\n");
    expect(await git("--get", "credential.https://gitlab.com.helper")).toBe("");
    const cfg = read(".ssh/config");
    expect(cfg).not.toContain("Host github.com");
    expect(cfg).not.toContain("Host gitlab.com");
    expect(cfg).toContain("Host git.example.com");
    expect(read(".ssh/known_hosts")).not.toContain("github.com");
    expect(ghCalls.map((c) => c.args.slice(1, 3).join(" "))).toEqual(["auth logout"]);
  });

  it("identity is set only when unset", async () => {
    await run("git", ["config", "--global", "user.name", "Existing"]);
    await reconcileGit(exec, "alice", {
      connections: [],
      identity: { name: "octo", email: "e@x.io" },
    });
    expect(await git("--get", "user.name")).toBe("Existing");
    expect(await git("--get", "user.email")).toBe("e@x.io");
  });

  it("an empty desired state leaves no managed files with content", async () => {
    await reconcileGit(exec, "alice", { connections: [gl] });
    await reconcileGit(exec, "alice", { connections: [] });
    expect(read(".agentbox/git-credentials")).toBe("");
    expect(existsSync(file(".ssh/config")) ? read(".ssh/config") : "").toBe("");
    chmodSync(file(".ssh"), 0o700);
  });
});
