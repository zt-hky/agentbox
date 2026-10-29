"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@agentbox/db/client";
import { guard } from "@/lib/action";
import { adminContext } from "@/lib/admin";
import { cancelJob, retryJob } from "@/lib/admin/system-jobs";

const idSchema = z.uuid();

export async function retryJobAction(jobId: string) {
  return guard(async () => {
    const { admin, ip } = await adminContext();
    await retryJob(db, {
      jobId: idSchema.parse(jobId),
      admin: { id: admin.id, email: admin.email },
      ip,
    });
    revalidatePath("/admin/jobs");
    revalidatePath("/admin");
  });
}

export async function cancelJobAction(jobId: string) {
  return guard(async () => {
    const { admin, ip } = await adminContext();
    await cancelJob(db, {
      jobId: idSchema.parse(jobId),
      admin: { id: admin.id, email: admin.email },
      ip,
    });
    revalidatePath("/admin/jobs");
    revalidatePath("/admin");
  });
}
