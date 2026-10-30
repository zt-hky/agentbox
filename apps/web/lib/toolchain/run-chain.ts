import { catalogEntry, type PlanStep, type StepRecord } from "@agentbox/core/toolchain";
import type { ChainItem } from "@/components/chain";
import type { RunView } from "./view";

const VERB: Record<PlanStep["action"], { now: string; done: string }> = {
  install: { now: "Installing", done: "Installed" },
  upgrade: { now: "Upgrading", done: "Upgraded" },
  downgrade: { now: "Downgrading", done: "Downgraded" },
  reinstall: { now: "Reinstalling", done: "Reinstalled" },
  remove: { now: "Removing", done: "Removed" },
  relink: { now: "Switching", done: "Switched" },
  verify: { now: "Verifying", done: "Verified" },
};

/** Plan actions that the agent records as a single step action. */
const RECORD_ACTION: Record<PlanStep["action"], StepRecord["action"]> = {
  install: "install",
  upgrade: "install",
  downgrade: "install",
  reinstall: "install",
  remove: "remove",
  relink: "relink",
  verify: "verify",
};

const toolLabel = (id: string) => catalogEntry(id)?.label ?? id;

function fromRecord(r: StepRecord): PlanStep {
  return { tool: r.tool, action: r.action, from: r.previous ?? null, to: r.version ?? null };
}

/** One chain item per planned step, joined to the agent's step record when it has started. */
export function runChainItems(run: RunView): ChainItem[] {
  const records = [...run.steps];
  const planned: PlanStep[] = run.plan?.steps.length ? run.plan.steps : records.map(fromRecord);
  return planned.map((step, i) => {
    const idx = records.findIndex(
      (r) => r.tool === step.tool && r.action === RECORD_ACTION[step.action],
    );
    const record = idx >= 0 ? records.splice(idx, 1)[0] : undefined;
    const state: ChainItem["state"] = !record
      ? "pending"
      : record.status === "failed"
        ? "failed"
        : record.status === "running"
          ? run.open
            ? "active"
            : "pending"
          : "done";
    const verb = VERB[step.action];
    const target = step.to ?? record?.version ?? null;
    return {
      key: `${step.tool}-${step.action}-${i}`,
      label: `${state === "done" ? verb.done : verb.now} ${toolLabel(step.tool)}`,
      detail:
        state === "failed" && record?.error
          ? record.error
          : step.from && target
            ? `${step.from} to ${target}`
            : (target ?? undefined),
      state,
    };
  });
}
