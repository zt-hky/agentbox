import { describe, expect, it } from "vitest";
import {
  T3_COPILOT_INSTANCE,
  copilotLoginCancel,
  copilotLoginStart,
  copilotLoginState,
  copilotLogout,
  deriveCopilotLogin,
  ghDisconnect,
  mergeCopilotProvider,
  parseLoginSnapshot,
  removeGhCredentialHelpers,
  setCopilotProvider,
  type ContainerExec,
} from "../src/accounts.ts";
import { HttpError } from "../src/errors.ts";

const LOG =
  "To authenticate, visit https://github.com/login/device and enter code 9B0A-2584\n" +
  "Waiting for authorization...\n";

const snap = (over: Record<string, string> = {}, log = "") => {
  const kv = { started: "1000", exit: "", cancelled: "0", alive: "1", ...over };
  return parseLoginSnapshot(
    Object.entries(kv)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + `\n---log\n${log}`,
  );
};

describe("copilot device-login state machine", () => {
  it("no session directory is idle", () => {
    expect(deriveCopilotLogin(parseLoginSnapshot("none\n"), 5000).status).toBe("idle");
  });

  it("starting until the code appears, then code with the device URL and expiry", () => {
    expect(deriveCopilotLogin(snap(), 1002).status).toBe("starting");
    const s = deriveCopilotLogin(snap({}, LOG), 1100);
    expect(s).toEqual({
      status: "code",
      userCode: "9B0A-2584",
      verificationUri: "https://github.com/login/device",
      expiresAt: new Date((1000 + 900) * 1000).toISOString(),
      error: null,
    });
  });

  it("exit 0 is signed in; non-zero is failed with the last log line", () => {
    expect(deriveCopilotLogin(snap({ exit: "0", alive: "0" }, LOG), 1100).status).toBe("signed_in");
    const failed = deriveCopilotLogin(snap({ exit: "1", alive: "0" }, "boom: network\n"), 1100);
    expect(failed).toMatchObject({ status: "failed", error: "boom: network" });
  });

  it("expires 15 minutes after start, or when the CLI says the code expired", () => {
    expect(deriveCopilotLogin(snap({}, LOG), 1000 + 899).status).toBe("code");
    expect(deriveCopilotLogin(snap({}, LOG), 1000 + 900).status).toBe("expired");
    expect(
      deriveCopilotLogin(snap({ exit: "1", alive: "0" }, "The device code has expired\n"), 1100)
        .status,
    ).toBe("expired");
  });

  it("cancelled wins over everything; a dead process without a result fails after a grace period", () => {
    expect(deriveCopilotLogin(snap({ cancelled: "1", alive: "0" }, LOG), 1100).status).toBe(
      "cancelled",
    );
    expect(deriveCopilotLogin(snap({ alive: "0" }), 1002).status).toBe("starting");
    expect(deriveCopilotLogin(snap({ alive: "0" }), 1010).status).toBe("failed");
  });

  it("never surfaces a verification URL other than github.com/login/device", () => {
    const evil = "To authenticate, visit https://evil.example/x and enter code 9B0A-2584\n";
    expect(deriveCopilotLogin(snap({}, evil), 1100).status).toBe("failed");
  });
});

interface Call {
  args: string[];
  input?: string;
}
function fakeExec(reply: (args: string[]) => { code?: number; stdout?: string; stderr?: string }) {
  const calls: Call[] = [];
  const exec: ContainerExec = async (args, opts) => {
    calls.push({ args, input: opts?.input });
    const r = reply(args);
    const out = { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    if (out.code !== 0 && opts?.check !== false) throw new Error(`exit ${out.code}`);
    return out;
  };
  return { exec, calls };
}
const script = (c: Call) => c.args.join(" ");

describe("copilotLoginStart", () => {
  it("refuses with 409 when copilot is not installed", async () => {
    const { exec, calls } = fakeExec((a) => ({
      code: script({ args: a }).includes("command -v") ? 1 : 0,
    }));
    await expect(copilotLoginStart(exec)).rejects.toMatchObject({ status: 409 });
    expect(calls).toHaveLength(1);
  });

  it("reuses a live session instead of restarting it (the shown code stays valid)", async () => {
    const live = "started=1000\nexit=\ncancelled=0\nalive=1\n---log\n" + LOG;
    const { exec, calls } = fakeExec((a) => ({
      stdout: script({ args: a }).includes("---log") ? live : "",
    }));
    const s = await copilotLoginStart(exec, () => 1100);
    expect(s.userCode).toBe("9B0A-2584");
    expect(calls.some((c) => script(c).includes("copilot login --device-code"))).toBe(false);
  });

  it("starts a session when none is live, then reports its state", async () => {
    let started = false;
    const { exec, calls } = fakeExec((a) => {
      const s = script({ args: a });
      if (s.includes("copilot login --device-code")) started = true;
      if (s.includes("---log"))
        return {
          stdout: started ? "started=1000\nexit=\ncancelled=0\nalive=1\n---log\n" : "none\n",
        };
      return {};
    });
    const s = await copilotLoginStart(exec, () => 1001);
    expect(s.status).toBe("starting");
    expect(calls.filter((c) => script(c).includes("copilot login --device-code"))).toHaveLength(1);
  });

  it("stops the waiting process once the code has expired", async () => {
    const stale = "started=1000\nexit=\ncancelled=0\nalive=1\n---log\n" + LOG;
    const { exec, calls } = fakeExec((a) => ({
      stdout: script({ args: a }).includes("---log") ? stale : "",
    }));
    const s = await copilotLoginState(exec, () => 3000);
    expect(s.status).toBe("expired");
    expect(calls.some((c) => script(c).includes('"$d/cancelled"'))).toBe(true);
  });
});

describe("T3 Copilot provider seeding", () => {
  const seed = JSON.stringify({
    enableProviderUpdateChecks: false,
    providerInstances: { ohmypi: { driver: "ohmypi", config: { binaryPath: "omp" } } },
  });

  it("adds the acpRegistry local instance and keeps every other key and its order", () => {
    const r = mergeCopilotProvider(seed, true);
    expect(r.changed).toBe(true);
    const out = JSON.parse(r.text);
    expect(out.providerInstances.copilot).toEqual(T3_COPILOT_INSTANCE);
    expect(out.providerInstances.ohmypi.config.binaryPath).toBe("omp");
    expect(Object.keys(out)).toEqual(["enableProviderUpdateChecks", "providerInstances"]);
  });

  it("is idempotent: seeding twice and removing twice change nothing the second time", () => {
    const once = mergeCopilotProvider(seed, true);
    const twice = mergeCopilotProvider(once.text, true);
    expect(twice.changed).toBe(false);
    const removed = mergeCopilotProvider(once.text, false);
    expect(removed.changed).toBe(true);
    expect(JSON.parse(removed.text).providerInstances.copilot).toBeUndefined();
    expect(mergeCopilotProvider(removed.text, false).changed).toBe(false);
  });

  it("creates the file content when settings.json is missing or empty", () => {
    for (const input of [null, "", "  \n"]) {
      const r = mergeCopilotProvider(input, true);
      expect(JSON.parse(r.text)).toEqual({ providerInstances: { copilot: T3_COPILOT_INSTANCE } });
    }
    expect(mergeCopilotProvider(null, false).changed).toBe(false);
  });

  it("leaves a user-edited copilot instance alone, on seed and on removal", () => {
    const edited = JSON.stringify({
      providerInstances: {
        copilot: {
          driver: "acpRegistry",
          config: { source: "local", commandPath: "/opt/copilot", commandArgs: ["--acp", "--x"] },
        },
      },
    });
    expect(mergeCopilotProvider(edited, true).changed).toBe(false);
    expect(mergeCopilotProvider(edited, false).changed).toBe(false);
  });

  it("refuses to touch a settings.json that is not valid or not an object", () => {
    for (const bad of ["{nope", "[]", '{"providerInstances":[]}']) {
      expect(() => mergeCopilotProvider(bad, true)).toThrow(HttpError);
    }
  });

  it("setCopilotProvider only writes when the content changes, via tmp + mv", async () => {
    let file = seed;
    const { exec, calls } = fakeExec((a) => {
      const s = script({ args: a });
      return { stdout: s.includes("cat ") && !s.includes("cat >") ? file : "" };
    });
    const wrapped: ContainerExec = async (args, opts) => {
      if (opts?.input !== undefined) file = opts.input;
      return exec(args, opts);
    };
    await setCopilotProvider(wrapped, true);
    await setCopilotProvider(wrapped, true);
    const writes = calls.filter((c) => c.input !== undefined);
    expect(writes).toHaveLength(1);
    expect(script(writes[0]!)).toContain("mv -f");
    await setCopilotProvider(wrapped, false);
    expect(JSON.parse(file).providerInstances.copilot).toBeUndefined();
  });
});

describe("disconnect reverse state", () => {
  const helperReply =
    (sections: Record<string, string>) =>
    (a: string[]): { code?: number; stdout?: string; stderr?: string } => {
      const key = a.join(" ");
      for (const [host, out] of Object.entries(sections))
        if (key.includes(`--get-all credential.${host}.helper`)) return { stdout: out };
      if (key.includes("--get-all")) return { code: 1 };
      return {};
    };
  const gh = "\n!/usr/bin/gh auth git-credential\n";

  it("removes only the credential sections gh wrote", async () => {
    const { exec, calls } = fakeExec(
      helperReply({ "https://github.com": gh, "https://gist.github.com": `${gh}store\n` }),
    );
    expect(await removeGhCredentialHelpers(exec)).toEqual(["https://github.com"]);
    const removals = calls.filter((c) => c.args.includes("--remove-section"));
    expect(removals.map((c) => c.args.at(-1))).toEqual(["credential.https://github.com"]);
  });

  it("ghDisconnect logs out, then removes helpers; an already logged-out gh is fine", async () => {
    const { exec, calls } = fakeExec((a) =>
      a[0] === "gh"
        ? { code: 1, stderr: "not logged in to any hosts" }
        : helperReply({ "https://github.com": gh })(a),
    );
    await ghDisconnect(exec);
    expect(calls[0]!.args.slice(0, 3)).toEqual(["gh", "auth", "logout"]);
    expect(calls.some((c) => c.args.includes("--remove-section"))).toBe(true);
  });

  it("ghDisconnect surfaces a real gh failure", async () => {
    const { exec } = fakeExec((a) => (a[0] === "gh" ? { code: 4, stderr: "disk error" } : {}));
    await expect(ghDisconnect(exec)).rejects.toMatchObject({ status: 500 });
  });

  it("copilotLogout cancels any session, deletes the login and unseeds the provider", async () => {
    const seeded = JSON.stringify({ providerInstances: { copilot: T3_COPILOT_INSTANCE } });
    let file = seeded;
    const { exec, calls } = fakeExec((a) => {
      const s = script({ args: a });
      return { stdout: s.includes("cat ") && !s.includes("cat >") ? file : "" };
    });
    const wrapped: ContainerExec = async (args, opts) => {
      if (opts?.input !== undefined) file = opts.input;
      return exec(args, opts);
    };
    await copilotLogout(wrapped);
    const order = calls.map((c) => script(c));
    expect(order[0]).toContain('"$d/cancelled"');
    expect(order[1]).toContain('rm -f "$HOME/.copilot/config.json"');
    expect(JSON.parse(file).providerInstances.copilot).toBeUndefined();
  });

  it("copilotLogout fails loudly when the login file could not be removed", async () => {
    const { exec } = fakeExec((a) => ({ code: script({ args: a }).includes("rm -f") ? 1 : 0 }));
    await expect(copilotLogout(exec)).rejects.toMatchObject({ status: 500 });
  });

  it("copilotLoginCancel is a single static script", async () => {
    const { exec, calls } = fakeExec(() => ({}));
    await copilotLoginCancel(exec);
    expect(calls).toHaveLength(1);
  });
});
