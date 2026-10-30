import { Chain, ChainBar } from "@/components/chain";
import { runChainItems } from "@/lib/toolchain/run-chain";
import type { RunView } from "@/lib/toolchain/view";

/** Animated progress for the open or last run. Motion stops as soon as the run is no longer open. */
export function RunChain({ run }: { run: RunView }) {
  const items = runChainItems(run);
  if (items.length === 0) return null;
  const finished = items.filter((i) => i.state === "done" || i.state === "failed").length;
  return (
    <div className="space-y-4">
      <ChainBar
        value={finished / items.length}
        active={run.open}
        label={`${finished} of ${items.length} steps finished`}
      />
      <Chain items={items} />
    </div>
  );
}
