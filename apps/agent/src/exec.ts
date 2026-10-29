import { spawn, type ChildProcess } from "node:child_process";
import { CMD_TIMEOUT_MS } from "./config.ts";
import { HttpError } from "./errors.ts";
import { transportPrefix } from "./argv.ts";

export interface RunOptions {
  input?: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** Throw on a non-zero exit (default true). */
  check?: boolean;
  /** Strings replaced by *** in error messages. */
  redact?: string[];
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class CommandError extends Error {
  readonly code: number;
  readonly stderr: string;
  constructor(message: string, code: number, stderr: string) {
    super(message);
    this.name = "CommandError";
    this.code = code;
    this.stderr = stderr;
  }
}

function scrub(text: string, redact: string[] | undefined): string {
  let out = text;
  for (const r of redact ?? []) if (r) out = out.split(r).join("***");
  return out;
}

/** execFile-style spawn: argv array, no shell. cwd is `/` so tenant-side fallbacks can traverse it. */
export function run(file: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? CMD_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: "/",
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let settled = false;
    let failure: Error | null = null;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      failure = new CommandError(`${file} timed out after ${timeoutMs}ms`, -1, "");
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout?.on("data", (c: Buffer) => {
      outBytes += c.length;
      if (outBytes > maxBytes) {
        failure ??= new CommandError(`${file} output exceeded ${maxBytes} bytes`, -1, "");
        child.kill("SIGKILL");
        return;
      }
      out.push(c);
    });
    child.stderr?.on("data", (c: Buffer) => {
      if (err.reduce((n, b) => n + b.length, 0) < 64 * 1024) err.push(c);
    });
    child.on("error", (e) =>
      finish(() => reject(new CommandError(`${file}: ${e.message}`, -1, ""))),
    );
    child.on("close", (code, signal) => {
      finish(() => {
        const stdout = Buffer.concat(out).toString("utf8");
        const stderr = scrub(Buffer.concat(err).toString("utf8"), opts.redact);
        if (failure) return reject(failure);
        const exit = code ?? (signal ? 128 : -1);
        if (exit !== 0 && opts.check !== false) {
          const detail = stderr.trim().split("\n").slice(-5).join(" | ").slice(0, 500);
          return reject(
            new CommandError(`${file} ${args[0] ?? ""} exited ${exit}: ${detail}`, exit, stderr),
          );
        }
        resolve({ code: exit, stdout, stderr });
      });
    });
    if (opts.input !== undefined && child.stdin) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(opts.input);
    }
  });
}

/** Run argv inside `user`'s systemd user manager (validated transport, host-validation.md A). */
export function runAs(
  user: string,
  argv: string[],
  opts: RunOptions & { detached?: boolean } = {},
): Promise<RunResult> {
  const [file, ...rest] = [...transportPrefix(user, { detached: opts.detached }), ...argv];
  return run(file as string, rest, opts);
}

/** Pipe the stdout of `producer` into the stdin of `consumer`; both must succeed. */
export function pipeProcesses(
  producer: { file: string; args: string[] },
  consumer: { file: string; args: string[] },
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const a = spawn(producer.file, producer.args, { cwd: "/", stdio: ["ignore", "pipe", "pipe"] });
    const b = spawn(consumer.file, consumer.args, { cwd: "/", stdio: ["pipe", "ignore", "pipe"] });
    const errs: string[] = [];
    const collect = (name: string, c: ChildProcess) =>
      c.stderr?.on("data", (d: Buffer) => {
        if (errs.join("").length < 4000) errs.push(`${name}: ${d.toString("utf8")}`);
      });
    collect(producer.file, a);
    collect(consumer.file, b);
    a.stdout?.pipe(b.stdin as NodeJS.WritableStream);
    let pending = 2;
    let bad: string | null = null;
    const timer = setTimeout(() => {
      bad = "pipeline timed out";
      a.kill("SIGKILL");
      b.kill("SIGKILL");
    }, timeoutMs);
    const done = (name: string, code: number | null) => {
      if (code !== 0 && bad === null) bad = `${name} exited ${code}`;
      if (--pending === 0) {
        clearTimeout(timer);
        if (bad) reject(new CommandError(`${bad}: ${errs.join("").slice(-500)}`, 1, errs.join("")));
        else resolve();
      }
    };
    a.on("error", (e) => done(`${producer.file} (${e.message})`, -1));
    b.on("error", (e) => done(`${consumer.file} (${e.message})`, -1));
    a.on("close", (c) => done(producer.file, c));
    b.on("close", (c) => done(consumer.file, c));
  });
}

export function asHttpError(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  return new HttpError(500, e instanceof Error ? e.message : String(e));
}
