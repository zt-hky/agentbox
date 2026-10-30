import { describe, expect, it } from "vitest";
import {
  AGENT_CREDENTIAL_ENV_VARS,
  credentialSpecs,
  findCredentialSpec,
  maskCredential,
  normalizeCredentialValue,
  renderSecretsEnv,
  shellQuote,
} from "../src/agent-credentials.ts";
import { CATALOG } from "../src/toolchain/index.ts";

describe("agent credentials", () => {
  it("claude takes an API key or a setup-token OAuth token; codex takes OPENAI_API_KEY", () => {
    expect(credentialSpecs("claude").map((s) => s.envVar)).toEqual([
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]);
    expect(credentialSpecs("codex").map((s) => s.envVar)).toEqual(["OPENAI_API_KEY"]);
    expect(findCredentialSpec("codex", "ANTHROPIC_API_KEY")).toBeUndefined();
    expect(credentialSpecs("copilot")).toEqual([]);
  });

  it("only catalog agents have credentials", () => {
    const agents = new Set(CATALOG.filter((e) => e.kind === "agent").map((e) => e.id as string));
    for (const id of Object.keys({ claude: 1, codex: 1, omp: 1, pi: 1, opencode: 1, grok: 1 })) {
      expect(agents.has(id)).toBe(true);
    }
    expect(AGENT_CREDENTIAL_ENV_VARS).toEqual(
      expect.arrayContaining(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "XAI_API_KEY"]),
    );
  });

  it("normalizes a pasted secret and rejects unusable ones", () => {
    expect(normalizeCredentialValue("  sk-abc\n")).toBe("sk-abc");
    expect(normalizeCredentialValue("")).toBeNull();
    expect(normalizeCredentialValue("a b")).toBeNull();
    expect(normalizeCredentialValue("a\nb")).toBeNull();
    expect(normalizeCredentialValue("x".repeat(5000))).toBeNull();
  });

  it("masks without leaking the middle", () => {
    const secret = "sk-ant-api03-SECRETSECRETSECRET-a1B2";
    const m = maskCredential(secret);
    expect(m).toBe("sk-ant…a1B2");
    expect(m).not.toContain("SECRET");
    expect(maskCredential("short")).toBe("••••");
  });

  it("renders a sourceable env file with safe quoting, sorted", () => {
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
    expect(renderSecretsEnv({ B: "2", A: "it's $HOME `x`" })).toBe(
      `# Managed by AgentBox. Edit credentials in Settings.\nexport A='it'\\''s $HOME \`x\`'\nexport B='2'\n`,
    );
    expect(renderSecretsEnv({})).toBe("# Managed by AgentBox. Edit credentials in Settings.\n");
  });
});
