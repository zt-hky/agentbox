"use client";

import { useState } from "react";
import type { RegistryHit } from "@agentbox/core/toolchain";
import { RegistrySearch } from "@/components/registry-search";
import { RegistryVersion } from "@/components/registry-version";
import { Button } from "@/components/ui/button";
import { parseChannelValue } from "@/lib/toolchain/version-options";
import { installToolAction } from "./actions";
import { useToolAction } from "./use-tool-action";

/** Search the mise registry, choose Latest or a version, and queue the install. */
export function RegistryAdd({ added }: { added: readonly string[] }) {
  const { pending, run } = useToolAction();
  const [picked, setPicked] = useState<RegistryHit | null>(null);
  const [version, setVersion] = useState("latest");

  const install = (hit: RegistryHit) =>
    run(async () => {
      const res = await installToolAction({
        toolId: hit.id,
        selection: parseChannelValue(version),
      });
      if (res.ok) {
        setPicked(null);
        setVersion("latest");
      }
      return res;
    }, `${hit.name} install queued`);

  return (
    <div className="space-y-3 border-b px-5 py-4">
      <RegistrySearch
        exclude={added}
        disabled={pending}
        onPick={(hit) => {
          setPicked(hit);
          setVersion("latest");
        }}
      />
      {picked ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3">
          <span className="min-w-0">
            <span className="block text-sm font-medium">{picked.name}</span>
            <span className="block text-meta text-muted-foreground">
              {picked.description || picked.backend}
            </span>
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <RegistryVersion
              toolId={picked.id}
              label={picked.name}
              value={version}
              onChange={setVersion}
              disabled={pending}
            />
            <Button
              size="sm"
              disabled={pending || (version.startsWith("pin:") && version.length <= 4)}
              onClick={() => install(picked)}
            >
              Install
            </Button>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => setPicked(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
