import type { Metadata } from "next";
import { desc } from "drizzle-orm";
import { db } from "@agentbox/db/client";
import { images } from "@agentbox/db/schema";
import { PageHeader } from "@/components/page-header";
import { extractVersions } from "@/lib/admin/system";
import { parseScanSummary, tailLog } from "@/lib/images";
import { ImagesPanel, type ImageRow } from "./images-panel";

export const metadata: Metadata = { title: "Images" };

export default async function AdminImagesPage() {
  const rows = await db.select().from(images).orderBy(desc(images.createdAt)).limit(50);
  const data: ImageRow[] = rows.map((r) => ({
    id: r.id,
    imageId: r.imageId,
    t3Ref: r.t3Ref,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    buildLog: tailLog(r.buildLog),
    overrideReason: r.overrideReason,
    scan: parseScanSummary(r.scanSummary),
    versions: extractVersions(r.buildLog),
  }));
  return (
    <>
      <PageHeader
        title="Workspace images"
        description="Exactly one image is active. A build pulls the latest tools, scans the result, and stays unused until you activate it."
      />
      <ImagesPanel rows={data} />
    </>
  );
}
