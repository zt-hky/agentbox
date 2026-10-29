import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { decideForRequest } from "@/lib/handoff-server";
import { sanitizeReturnPath } from "@/lib/paths";
import { requireAdmin } from "@/lib/session";
import { confirmAdminOpen } from "./actions";

export const metadata: Metadata = { title: "Open workspace as admin" };

export default async function ConfirmHandoffPage({
  searchParams,
}: {
  searchParams: Promise<{ host?: string; path?: string }>;
}) {
  const session = await requireAdmin();
  const { host, path } = await searchParams;
  const { decision } = await decideForRequest(host ?? null, session.user);
  if (decision.action !== "confirm") notFound();

  return (
    <div className="flex min-h-svh items-center justify-center bg-muted p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Open {decision.ws} as admin</CardTitle>
          <CardDescription>
            This workspace belongs to another user. Opening it is recorded in the audit log.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={confirmAdminOpen} className="flex gap-2">
            <input type="hidden" name="host" value={decision.host} />
            <input type="hidden" name="path" value={sanitizeReturnPath(path)} />
            <Button type="submit">Open {decision.ws} as admin</Button>
            <Button asChild variant="outline">
              <a href="/admin/workspaces">Cancel</a>
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
