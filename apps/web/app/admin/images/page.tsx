import type { Metadata } from "next";
import { db } from "@agentbox/db/client";
import { PageHeader } from "@/components/page-header";
import { imageOption } from "@/lib/admin/image-view";
import { loadImageOverview } from "@/lib/admin/images-ops";
import { extractVersions } from "@/lib/admin/system";
import { parseScanSummary, tailLog } from "@/lib/images";
import { requireAdmin } from "@/lib/session";
import { ImagesPanel, type ImageRow } from "./images-panel";

export const metadata: Metadata = { title: "Images" };
export const dynamic = "force-dynamic";

export default async function AdminImagesPage() {
  await requireAdmin();
  const { rows, live } = await loadImageOverview(db);
  const data: ImageRow[] = rows.map(({ image: r, usage, deleteQueued, lastDeleteError }) => ({
    ...imageOption(r),
    buildLog: tailLog(r.buildLog),
    overrideReason: r.overrideReason,
    scan: parseScanSummary(r.scanSummary),
    versions: extractVersions(r.buildLog),
    rootfsPresent: r.rootfsPath !== null,
    usage,
    deleteQueued,
    lastDeleteError,
  }));
  return (
    <>
      <PageHeader
        title="Workspace images"
        description="Exactly one image is active and new starts use it. A build produces a new base image, scans it, and stays unused until you activate it. Pin a workspace to an older or newer image from here or from its Manage tab."
      />
      <ImagesPanel rows={data} workspaces={live} />
    </>
  );
}
