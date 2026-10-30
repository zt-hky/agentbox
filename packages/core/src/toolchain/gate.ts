import { z } from "zod";
import { BAKED_TOOL_IDS, toolIdSchema } from "./catalog.ts";
import type { ToolState } from "./plan.ts";

/** Parsed `/opt/agentbox/versions.json` of a workspace image; stored in `images.manifest`. */
export const imageManifestSchema = z.object({
  mise: z.string().nullable(),
  /** Distro ABI the baked binaries and every per-workspace install were built against. */
  toolchainAbi: z.string().nullable(),
  envVersion: z.number().int().nullable(),
  /** The image bakes no runtimes or agent CLIs: workspaces must carry their own toolchain. */
  slim: z.boolean(),
  /** Catalog tools the image ships itself. */
  baked: z.array(toolIdSchema),
});
export type ImageManifest = z.infer<typeof imageManifestSchema>;

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** Build the manifest from the raw `versions.json` object (images built before this have none). */
export function manifestFromVersions(raw: unknown): ImageManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const mise = str(o["mise"]);
  const env = o["envVersion"];
  if (mise === null && o["slim"] === undefined && env === undefined) return null;
  const baked = BAKED_TOOL_IDS.filter((id) => str(o[id]) !== null);
  return {
    mise,
    toolchainAbi: str(o["toolchainAbi"]),
    envVersion: typeof env === "number" && Number.isInteger(env) ? env : null,
    slim: o["slim"] === true,
    baked: [...baked],
  };
}

export const parseImageManifest = (value: unknown): ImageManifest | null => {
  const r = imageManifestSchema.safeParse(value);
  return r.success ? r.data : null;
};

/** `ubuntu-26.04` -> 26.04; null when the ABI is not a recognisable `<distro>-<version>`. */
function abiRank(abi: string): { distro: string; version: number } | null {
  const m = /^([a-z]+)-(\d+(?:\.\d+)?)$/.exec(abi);
  return m ? { distro: m[1] as string, version: Number(m[2]) } : null;
}

/** An image older than the ABI a workspace's toolchain was installed under cannot be trusted to run it. */
export function abiIsOlder(imageAbi: string, installedAbi: string): boolean {
  const a = abiRank(imageAbi);
  const b = abiRank(installedAbi);
  if (!a || !b) return imageAbi !== installedAbi;
  return a.distro !== b.distro || a.version < b.version;
}

export interface GateTool {
  toolId: string;
  desired: boolean;
  state: ToolState;
  installedVersion: string | null;
  backend: string | null;
}

export interface GateWorkspace {
  slug: string;
  toolchainGeneration: number;
  toolchainAppliedGeneration: number;
  /** Set when a reconcile run ended with every step ok. */
  toolchainReconciledAt: Date | null;
  toolchainAbi: string | null;
  tools: readonly GateTool[];
}

export interface GateVerdict {
  ok: boolean;
  /** Plain reasons the workspace cannot move to the image (empty when ok). */
  reasons: string[];
}

/**
 * P4 safety gate. An image whose manifest says `slim` (or that carries an older ABI than a
 * workspace's installed toolchain) may only be activated, pinned or bulk-moved for workspaces whose
 * managed toolchain is complete: the last reconcile succeeded, nothing is pending, and every
 * desired tool has a managed copy. Otherwise the workspace would lose the tools the old image
 * provided.
 */
export function evaluateImageGate(manifest: ImageManifest | null, ws: GateWorkspace): GateVerdict {
  const reasons: string[] = [];
  if (
    manifest?.toolchainAbi &&
    ws.toolchainAbi &&
    abiIsOlder(manifest.toolchainAbi, ws.toolchainAbi)
  ) {
    reasons.push(
      `This image is built for ${manifest.toolchainAbi}; the workspace toolchain was installed for ${ws.toolchainAbi}.`,
    );
  }
  if (manifest?.slim) {
    if (!manifest.mise)
      reasons.push("The image has no mise, so the toolchain cannot be reconciled on it.");
    if (!ws.toolchainReconciledAt) reasons.push("No toolchain reconcile has succeeded yet.");
    else if (ws.toolchainAppliedGeneration < ws.toolchainGeneration)
      reasons.push("A toolchain change has not been applied yet.");
    for (const t of ws.tools) {
      if (!t.desired) continue;
      const managed = t.backend !== null && t.installedVersion !== null && t.state !== "external";
      if (!managed) {
        reasons.push(
          t.state === "failed"
            ? `${t.toolId} failed to install.`
            : t.state === "external"
              ? `${t.toolId} is still provided by the image.`
              : `${t.toolId} is not installed in the workspace.`,
        );
      } else if (t.state === "failed") {
        reasons.push(`${t.toolId} failed its last change.`);
      }
    }
  }
  return { ok: reasons.length === 0, reasons };
}
