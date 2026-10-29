"use client";

import Link from "next/link";
import { Fragment, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { CodeBlock } from "@/components/code-block";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Mono } from "@/components/mono";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cancelJobAction, retryJobAction } from "./actions";

export interface JobRowData {
  id: string;
  type: string;
  status: string;
  slug: string | null;
  attempts: number;
  lastError: string | null;
  payloadText: string;
  resultPreview: string;
  resultText: string;
  createdAt: string;
  finishedAt: string;
  duration: string;
}

function RetryButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await retryJobAction(id);
          if (!res.ok) toast.error(res.error);
          else {
            toast.success("Job requeued");
            router.refresh();
          }
        })
      }
    >
      Retry
    </Button>
  );
}

function CancelButton({ id, type }: { id: string; type: string }) {
  const router = useRouter();
  return (
    <ConfirmDialog
      trigger={
        <Button size="sm" variant="outline">
          Cancel
        </Button>
      }
      title="Cancel this job?"
      description={
        <p>
          The {type.replaceAll("_", " ")} job has not started. Cancelling marks it failed with your
          email as the reason; nothing is undone because nothing ran.
        </p>
      }
      confirmLabel="Cancel job"
      destructive
      onConfirm={async () => {
        const res = await cancelJobAction(id);
        if (res.ok) {
          toast.success("Job cancelled");
          router.refresh();
        }
        return res;
      }}
    />
  );
}

export function JobsTable({ rows }: { rows: JobRowData[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Table>
      <TableHeader className="bg-rack">
        <TableRow>
          <TableHead className="h-9 w-8 pl-5" />
          <TableHead className="hidden h-9 text-meta font-medium text-muted-foreground md:table-cell">
            Status
          </TableHead>
          <TableHead className="h-9 text-meta font-medium text-muted-foreground">Job</TableHead>
          <TableHead className="h-9 text-meta font-medium text-muted-foreground hidden md:table-cell">
            Attempts
          </TableHead>
          <TableHead className="h-9 text-meta font-medium text-muted-foreground hidden lg:table-cell">
            Outcome
          </TableHead>
          <TableHead className="h-9 text-meta font-medium text-muted-foreground hidden md:table-cell">
            Created
          </TableHead>
          <TableHead className="h-9 text-meta font-medium text-muted-foreground hidden md:table-cell">
            Duration
          </TableHead>
          <TableHead className="h-9 pr-5" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => {
          const expanded = open === r.id;
          return (
            <Fragment key={r.id}>
              <TableRow data-state={expanded ? "selected" : undefined}>
                <TableCell className="pl-5">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-label={`${expanded ? "Hide" : "Show"} details for ${r.type} job`}
                    onClick={() => setOpen(expanded ? null : r.id)}
                    className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-rack hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    <ChevronRight className={expanded ? "size-4 rotate-90" : "size-4"} />
                  </button>
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  <StatusBadge status={r.status} />
                </TableCell>
                <TableCell>
                  <div>
                    <Mono>{r.type}</Mono>
                  </div>
                  <div className="my-1 md:hidden">
                    <StatusBadge status={r.status} />
                  </div>
                  {r.slug ? (
                    <Link
                      href={`/admin/workspaces/${r.slug}`}
                      className="text-meta text-signal hover:underline"
                    >
                      <Mono>{r.slug}</Mono>
                    </Link>
                  ) : (
                    <span className="text-meta text-muted-foreground">Platform job</span>
                  )}
                </TableCell>
                <TableCell className="hidden tabular-nums md:table-cell">{r.attempts}</TableCell>
                <TableCell className="hidden max-w-[18rem] lg:table-cell">
                  {r.lastError ? (
                    <p className="truncate text-destructive" title={r.lastError}>
                      {r.lastError}
                    </p>
                  ) : r.resultPreview ? (
                    <p
                      className="truncate font-mono text-xs text-muted-foreground"
                      title={r.resultPreview}
                    >
                      {r.resultPreview}
                    </p>
                  ) : (
                    <span className="text-muted-foreground">No output</span>
                  )}
                </TableCell>
                <TableCell className="hidden text-meta whitespace-nowrap md:table-cell">
                  {r.createdAt}
                </TableCell>
                <TableCell className="hidden text-meta whitespace-nowrap md:table-cell">
                  {r.duration}
                </TableCell>
                <TableCell className="pr-5">
                  <div className="flex justify-end gap-2">
                    {r.status === "failed" ? <RetryButton id={r.id} /> : null}
                    {r.status === "queued" ? <CancelButton id={r.id} type={r.type} /> : null}
                  </div>
                </TableCell>
              </TableRow>
              {expanded ? (
                <TableRow className="bg-rack/60 hover:bg-rack/60">
                  <TableCell colSpan={8} className="px-5 py-4">
                    <div className="grid gap-4 lg:grid-cols-2">
                      <div className="min-w-0 space-y-1.5">
                        <p className="text-meta text-muted-foreground">Payload</p>
                        <CodeBlock
                          text={r.payloadText || "No payload"}
                          label="Job payload"
                          maxHeight="14rem"
                          wrap
                        />
                      </div>
                      <div className="min-w-0 space-y-1.5">
                        <p className="text-meta text-muted-foreground">Result</p>
                        <CodeBlock
                          text={r.resultText || "No result"}
                          label="Job result"
                          maxHeight="14rem"
                          wrap
                        />
                      </div>
                      {r.lastError ? (
                        <div className="min-w-0 space-y-1.5 lg:col-span-2">
                          <p className="text-meta text-muted-foreground">Last error</p>
                          <CodeBlock text={r.lastError} label="Last error" maxHeight="10rem" wrap />
                        </div>
                      ) : null}
                      <dl className="grid gap-x-6 gap-y-1 text-meta text-muted-foreground sm:grid-cols-[auto_1fr] lg:col-span-2">
                        <dt>Job ID</dt>
                        <dd className="font-mono break-all text-foreground">{r.id}</dd>
                        <dt>Attempts</dt>
                        <dd className="text-foreground">{r.attempts}</dd>
                        <dt>Created</dt>
                        <dd className="text-foreground">{r.createdAt}</dd>
                        <dt>Finished</dt>
                        <dd className="text-foreground">{r.finishedAt}</dd>
                        <dt>Duration</dt>
                        <dd className="text-foreground">{r.duration}</dd>
                      </dl>
                    </div>
                  </TableCell>
                </TableRow>
              ) : null}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}
