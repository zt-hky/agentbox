import { describe, expect, it } from "vitest";
import { GITHUB_BASE_SCOPES } from "../src/accounts.ts";
import {
  GIT_OAUTH,
  GIT_PROVIDER_IDS,
  GIT_PROVIDERS,
  PINNED_SSH_FINGERPRINTS,
  PINNED_SSH_HOST_KEYS,
  gitCredentialUsername,
  gitOAuthScopes,
  githubCanUploadKeys,
  knownHostsFor,
  normalizeGitHost,
  pinnedKnownHosts,
  sshUploadSupported,
} from "../src/git.ts";
import { sshKeyFingerprint } from "../src/tokens.ts";

describe("provider registry", () => {
  it("has an entry for every provider id", () => {
    for (const id of GIT_PROVIDER_IDS) expect(GIT_PROVIDERS[id].id).toBe(id);
  });
  it("github scopes include write:public_key; workflow is opt-in", () => {
    expect(GITHUB_BASE_SCOPES).toContain("write:public_key");
    expect(gitOAuthScopes("github")).toBe("repo read:org gist write:public_key");
    expect(gitOAuthScopes("github", true)).toBe("repo read:org gist write:public_key workflow");
  });
  it("gitlab and bitbucket use the specified scopes and callbacks", () => {
    expect(gitOAuthScopes("gitlab")).toBe("api read_user write_repository");
    expect(gitOAuthScopes("bitbucket")).toBe("account repository:write pullrequest");
    expect(GIT_OAUTH.gitlab.callbackPath).toBe("/api/git/gitlab/callback");
    expect(GIT_OAUTH.bitbucket.callbackPath).toBe("/api/git/bitbucket/callback");
    expect(GIT_OAUTH.gitlab.clientIdEnv).toBe("GITLAB_CLIENT_ID");
    expect(GIT_OAUTH.bitbucket.clientSecretEnv).toBe("BITBUCKET_CLIENT_SECRET");
  });
  it("credential usernames", () => {
    expect(gitCredentialUsername({ provider: "github", method: "oauth", login: "me" })).toBe("me");
    expect(gitCredentialUsername({ provider: "gitlab", method: "oauth", login: "me" })).toBe(
      "oauth2",
    );
    expect(gitCredentialUsername({ provider: "bitbucket", method: "oauth", login: "me" })).toBe(
      "x-token-auth",
    );
    expect(gitCredentialUsername({ provider: "gitlab", method: "token", login: "me" })).toBe("me");
    expect(gitCredentialUsername({ provider: "gitea", method: "token", login: "me" })).toBe("me");
  });
  it("ssh upload support", () => {
    expect(sshUploadSupported("github", "oauth")).toBe(true);
    expect(sshUploadSupported("gitea", "token")).toBe(true);
    expect(sshUploadSupported("bitbucket", "oauth")).toBe(true);
    expect(sshUploadSupported("generic", "token")).toBe(false);
  });
  it("detects the github key-upload scope", () => {
    expect(githubCanUploadKeys("repo,write:public_key")).toBe(true);
    expect(githubCanUploadKeys("repo read:org gist")).toBe(false);
    expect(githubCanUploadKeys(null)).toBe(false);
  });
});

describe("normalizeGitHost", () => {
  it.each([
    ["git.example.com", "git.example.com"],
    ["  GitLab.Example.ORG ", "gitlab.example.org"],
    ["code.corp.example.co.uk.", "code.corp.example.co.uk"],
  ])("accepts %s", (input, out) => expect(normalizeGitHost(input)).toBe(out));
  it.each([
    "localhost",
    "foo.localhost",
    "10.0.0.1",
    "127.0.0.1",
    "[::1]",
    "::1",
    "https://git.example.com",
    "git.example.com:8443",
    "git.example.com/path",
    "http://git.example.com",
    "nodots",
    "a b.example.com",
    "-bad.example.com",
    "printer.local",
    "svc.internal",
    "",
  ])("rejects %j", (input) => expect(normalizeGitHost(input)).toBeNull());
});

describe("pinned known hosts", () => {
  it("ships keys whose fingerprints match the official ones", () => {
    for (const [host, keys] of Object.entries(PINNED_SSH_HOST_KEYS)) {
      const fps = keys.map((k) => sshKeyFingerprint(k)).sort();
      expect(fps).toEqual([...PINNED_SSH_FINGERPRINTS[host]!].sort());
    }
  });
  it("covers github.com, gitlab.com and bitbucket.org with ed25519 + rsa + ecdsa", () => {
    for (const host of ["github.com", "gitlab.com", "bitbucket.org"]) {
      const text = pinnedKnownHosts(host)!;
      expect(text.split("\n")).toHaveLength(3);
      expect(text).toContain(`${host} ssh-ed25519 `);
      expect(text).toContain(`${host} ssh-rsa `);
      expect(text).toContain(`${host} ecdsa-sha2-nistp256 `);
    }
  });
  it("self-hosted hosts use the stored scan, pinned hosts ignore it", () => {
    expect(pinnedKnownHosts("git.example.com")).toBeNull();
    expect(knownHostsFor("git.example.com", "git.example.com ssh-ed25519 AAAA\n")).toBe(
      "git.example.com ssh-ed25519 AAAA",
    );
    expect(knownHostsFor("git.example.com", null)).toBeNull();
    expect(knownHostsFor("github.com", "evil")).toBe(pinnedKnownHosts("github.com"));
  });
});
