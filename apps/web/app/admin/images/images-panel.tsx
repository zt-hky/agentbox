"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CodeBlock } from "@/components/code-block";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { Mono } from "@/components/mono";
import { Section } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/lib/action";
import type { ImageVersions } from "@/lib/admin/system";
import { shortImageId, workspaceImageState, type ImageOption } from "@/lib/admin/image-view";
import type { ImageUsage, WorkspaceImageRef } from "@/lib/admin/images-ops";
import { formatDateTime } from "@/lib/format";
import {
  activateImage,
  buildImage,
  deleteImage,
  moveWorkspacesToImage,
  pollImage,
  retireImage,
} from "./actions";

export interface ImageRow extends ImageOption {
  buildLog: string;
  rootfsPresent: boolean;
  usage: ImageUsage;
  deleteQueued: boolean;
  lastDeleteError: string | null;
  overrideReason: string | null;
  scan: { counts: Record<string, number>; fixableCritical: number } | null;
  versions: ImageVersions | null;
}

export const POLL_INTERVAL_MS = 3000;

function BuildLog({ id, initial }: { id: string; initial: string }) {
  const router = useRouter();
  const [log, setLog] = useState(initial);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const res = await pollImage(id);
      if (stopped) return;
      if (res.ok) {
        setLog(res.data.buildLog);
        if (res.data.status !== "building") {
          router.refresh(); // leaves `building`: stop polling
          return;
        }
      }
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    timer = setTimeout(tick, POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [id, router]);
  return (
    <CodeBlock
      text={log || "Waiting for build output..."}
      label="Build log"
      maxHeight="18rem"
      wrap
    />
  );
}

function ScanBadges({ scan }: { scan: ImageRow["scan"] }) {
  if (!scan) return <span className="text-meta text-muted-foreground">No scan results</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      <Badge variant={scan.counts.CRITICAL ? "destructive" : "outline"}>
        Critical {scan.counts.CRITICAL ?? 0}
      </Badge>
      <Badge variant="outline">High {scan.counts.HIGH ?? 0}</Badge>
      <Badge variant="outline">Medium {scan.counts.MEDIUM ?? 0}</Badge>
      <Badge variant="outline">Low {scan.counts.LOW ?? 0}</Badge>
      {scan.fixableCritical > 0 ? (
        <Badge variant="destructive">{scan.fixableCritical} fixable critical</Badge>
      ) : null}
    </div>
  );
}

type MoveMode = "none" | "running" | "all";

const MOVE_CHOICES: { value: MoveMode; title: string; hint: string }[] = [
  {
    value: "none",
    title: "Only new starts",
    hint: "Running workspaces keep their current image until they restart; sleeping ones use it on their next wake.",
  },
  {
    value: "running",
    title: "Also restart running workspaces onto it",
    hint: "Running workspaces that follow the active image and run another one restart now. Pinned ones stay pinned.",
  },
  {
    value: "all",
    title: "Move everyone: clear pins and restart running ones",
    hint: "Every workspace follows the new active image; pins are removed. Running ones on another image restart now.",
  },
];

function ActivateDialog({
  row,
  workspaces,
  onClose,
}: {
  row: ImageRow;
  workspaces: WorkspaceImageRef[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [reason, setReason] = useState("");
  const [mode, setMode] = useState<MoveMode>("none");
  const needsOverride = row.scan === null || row.scan.fixableCritical > 0;
  const behind = workspaces.filter(
    (w) =>
      w.status === "running" && w.imageId !== row.imageId && (mode === "all" || !w.pinnedImageId),
  ).length;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Activate {row.t3Ref}</DialogTitle>
          <DialogDescription>
            New starts use this image. The current active image becomes ready.
          </DialogDescription>
        </DialogHeader>
        <ScanBadges scan={row.scan} />
        {needsOverride ? (
          <div className="space-y-1.5">
            <Label htmlFor="override">
              {row.scan ? "Fixable critical vulnerabilities found" : "No scan results"}: override
              reason (required)
            </Label>
            <Textarea
              id="override"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        ) : null}
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">Workspaces</legend>
          {MOVE_CHOICES.map((c) => (
            <label key={c.value} className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="radio"
                name="move-mode"
                className="mt-1"
                checked={mode === c.value}
                onChange={() => setMode(c.value)}
              />
              <span>
                {c.title}
                <span className="block text-meta text-muted-foreground">{c.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {mode !== "none" ? (
          <p className="text-meta text-muted-foreground">
            {behind} running workspace{behind === 1 ? "" : "s"} will restart: running terminals and
            agents end.
          </p>
        ) : null}
        <DialogFooter>
          <Button
            disabled={pending || (needsOverride && !reason.trim())}
            onClick={() =>
              start(async () => {
                const res = await activateImage(row.id, needsOverride ? reason : null, mode);
                if (!res.ok) {
                  toast.error(res.error);
                  return;
                }
                toast.success(
                  res.data.restarted.length > 0
                    ? `Image activated; ${res.data.restarted.length} restart queued`
                    : "Image activated",
                );
                onClose();
                router.refresh();
              })
            }
          >
            {mode === "none" ? "Activate" : "Activate and move"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function imageLabel(rows: ImageRow[], imageId: string | null): string {
  if (!imageId) return "never started";
  const r = rows.find((i) => i.imageId === imageId);
  return `${r ? `${r.t3Ref} · ` : ""}${shortImageId(imageId)}`;
}

function MoveDialog({
  target,
  rows,
  workspaces,
  preselect,
  onClose,
}: {
  target: ImageRow;
  rows: ImageRow[];
  workspaces: WorkspaceImageRef[];
  preselect: string[] | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const movable = workspaces.filter((w) => w.status !== "provisioning");
  const [selected, setSelected] = useState(() => new Set(preselect ?? movable.map((w) => w.slug)));
  const isActive = target.status === "active";
  const [mode, setMode] = useState<"pin" | "follow">(isActive ? "follow" : "pin");
  const restarts = movable.filter(
    (w) => selected.has(w.slug) && w.status === "running" && w.imageId !== target.imageId,
  ).length;
  const toggle = (slug: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(slug);
      else next.delete(slug);
      return next;
    });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Move workspaces to {target.t3Ref}</DialogTitle>
          <DialogDescription>
            Image <Mono>{shortImageId(target.imageId)}</Mono>. Running workspaces on another image
            restart; sleeping ones use it on their next wake.
          </DialogDescription>
        </DialogHeader>
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">How</legend>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="move-how"
              className="mt-1"
              checked={mode === "pin"}
              onChange={() => setMode("pin")}
            />
            <span>
              Pin to this image
              <span className="block text-meta text-muted-foreground">
                They stay on it even when another image becomes active.
              </span>
            </span>
          </label>
          <label
            className={`flex items-start gap-2 text-sm ${isActive ? "" : "text-muted-foreground"}`}
          >
            <input
              type="radio"
              name="move-how"
              className="mt-1"
              disabled={!isActive}
              checked={mode === "follow"}
              onChange={() => setMode("follow")}
            />
            <span>
              Follow the active image
              <span className="block text-meta text-muted-foreground">
                {isActive
                  ? "Clears any pin; they track whichever image is active."
                  : "Only available for the active image."}
              </span>
            </span>
          </label>
        </fieldset>
        <div className="grid gap-2">
          <div className="flex items-center justify-between text-sm font-medium">
            <span>
              Workspaces ({selected.size} of {movable.length})
            </span>
            <span className="flex gap-3 text-meta font-normal">
              <button
                type="button"
                className="text-signal hover:underline"
                onClick={() => setSelected(new Set(movable.map((w) => w.slug)))}
              >
                All
              </button>
              <button
                type="button"
                className="text-signal hover:underline"
                onClick={() => setSelected(new Set())}
              >
                None
              </button>
            </span>
          </div>
          <ul className="max-h-64 divide-y overflow-y-auto rounded-md border">
            {movable.map((w) => {
              const here =
                w.imageId === target.imageId &&
                (mode === "follow" ? !w.pinnedImageId : w.pinnedImageId === target.id);
              return (
                <li key={w.slug} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <Checkbox
                    id={`mv-${w.slug}`}
                    checked={selected.has(w.slug)}
                    onCheckedChange={(c) => toggle(w.slug, c === true)}
                  />
                  <Label htmlFor={`mv-${w.slug}`} className="min-w-0 flex-1 gap-3 font-normal">
                    <Mono>{w.slug}</Mono>
                    <span className="truncate text-meta text-muted-foreground">
                      {imageLabel(rows, w.imageId)}
                      {w.pinnedImageId ? " · pinned" : ""}
                    </span>
                  </Label>
                  <StatusBadge status={w.status} />
                  {here ? <Badge variant="outline">Already here</Badge> : null}
                </li>
              );
            })}
          </ul>
        </div>
        <p className="text-meta text-muted-foreground">
          {restarts} running workspace{restarts === 1 ? "" : "s"} will restart: running terminals
          and agents end.
        </p>
        <DialogFooter>
          <Button
            disabled={pending || selected.size === 0}
            onClick={() =>
              start(async () => {
                const res = await moveWorkspacesToImage(target.id, [...selected], mode);
                if (!res.ok) {
                  toast.error(res.error);
                  return;
                }
                toast.success(
                  `${res.data.moved.length} workspace${res.data.moved.length === 1 ? "" : "s"} moved; ${res.data.restarted.length} restart${res.data.restarted.length === 1 ? "" : "s"} queued`,
                );
                onClose();
                router.refresh();
              })
            }
          >
            Move {selected.size} workspace{selected.size === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WorkspaceLinks({ list }: { list: { slug: string }[] }) {
  return (
    <>
      {list.map((w, i) => (
        <span key={w.slug}>
          {i > 0 ? ", " : ""}
          <Link
            href={`/admin/workspaces/${w.slug}?tab=manage`}
            className="font-mono text-signal underline-offset-4 hover:underline"
          >
            {w.slug}
          </Link>
        </span>
      ))}
    </>
  );
}

/** Why Delete is unavailable (workspace blockers link out); null when it is allowed. */
function deleteBlocked(r: ImageRow) {
  const { running, pinned } = r.usage;
  const reasons: React.ReactNode[] = [];
  if (r.status === "active") reasons.push("It is the active image. Activate another one first.");
  if (r.deleteQueued) reasons.push("A delete is already queued.");
  if (pinned.length > 0)
    reasons.push(
      <>
        Pinned by <WorkspaceLinks list={pinned} />. Unpin or move them first.
      </>,
    );
  if (running.length > 0)
    reasons.push(
      <>
        Running on it: <WorkspaceLinks list={running} />. Move them to another image first.
      </>,
    );
  return reasons;
}

function DeleteControl({
  r,
  busy,
  moveTarget,
  onMove,
  onDone,
}: {
  r: ImageRow;
  busy: boolean;
  /** The active image, used by "move them first". */
  moveTarget: ImageRow | null;
  onMove: (target: ImageRow, slugs: string[]) => void;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const reasons = deleteBlocked(r);
  const staleBuild = r.status === "building";
  const blockingSlugs = [...new Set([...r.usage.running, ...r.usage.pinned].map((w) => w.slug))];
  const hasFiles =
    r.status !== "failed" && !staleBuild && !(r.status === "retired" && !r.rootfsPresent);
  const trigger = (
    <Button size="sm" variant="outline" disabled={busy}>
      {staleBuild ? "Delete stale build" : "Delete"}
    </Button>
  );
  if (reasons.length === 0) {
    return (
      <ConfirmDialog
        trigger={trigger}
        title={`Delete ${r.t3Ref}?`}
        description={
          hasFiles
            ? "The image files are removed from the host and the image is marked retired. The build log stays for audit. This cannot be undone."
            : "This image has no files left; its record is removed. This cannot be undone."
        }
        confirmLabel="Delete image"
        destructive
        onConfirm={async () => {
          const res = await deleteImage(r.id);
          if (res.ok) {
            toast.success(res.data.queued ? "Delete queued" : "Image removed");
            onDone();
          }
          return res;
        }}
      />
    );
  }
  return (
    <>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => setOpen(true)}>
        Delete
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cannot delete {r.t3Ref} yet</DialogTitle>
            <DialogDescription>
              Deleting removes the files running and pinned workspaces need.
            </DialogDescription>
          </DialogHeader>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {reasons.map((reason, i) => (
              <li key={i}>{reason}</li>
            ))}
          </ul>
          <DialogFooter>
            {blockingSlugs.length > 0 && moveTarget && moveTarget.id !== r.id ? (
              <Button
                onClick={() => {
                  setOpen(false);
                  onMove(moveTarget, blockingSlugs);
                }}
              >
                Move them to {moveTarget.t3Ref} first
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function UsageLine({ usage }: { usage: ImageUsage }) {
  return (
    <span>
      Workspaces:{" "}
      <span className="text-foreground">
        {usage.running.length} running, {usage.sleeping.length} sleeping
      </span>
      {usage.pinned.length > 0 ? (
        <>
          , <span className="text-foreground">{usage.pinned.length} pinned</span>
        </>
      ) : null}
    </span>
  );
}

/** A `building` row older than this has no live build behind it. */
const isStale = (r: ImageRow) => Date.now() - Date.parse(r.createdAt) > 15 * 60_000;

function ImageEntry({
  r,
  onActivate,
  onMove,
  moveTarget,
  onMoveThem,
  busy,
}: {
  r: ImageRow;
  onActivate: () => void;
  onMove: () => void;
  moveTarget: ImageRow | null;
  onMoveThem: (target: ImageRow, slugs: string[]) => void;
  busy: boolean;
}) {
  const router = useRouter();
  const run = async (fn: () => Promise<ActionResult>, message: string) => {
    const res = await fn();
    if (res.ok) {
      toast.success(message);
      router.refresh();
    }
    return res;
  };
  const usable =
    r.imageId !== null &&
    (r.status === "ready" || r.status === "active" || (r.status === "retired" && r.rootfsPresent));
  const staleBuilding = r.status === "building" && isStale(r);
  const canDelete = r.status !== "active" && (r.status !== "building" || staleBuilding);
  return (
    <li className="grid gap-3 px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-center gap-3">
          <StatusBadge status={r.status} />
          <span className="truncate font-medium">
            <Mono>{r.t3Ref}</Mono>
          </span>
          {r.t3Version ? (
            <span className="truncate text-meta text-muted-foreground">
              <Mono>{r.t3Version}</Mono>
            </span>
          ) : null}
        </div>
        <span className="text-meta text-muted-foreground">
          {formatDateTime(new Date(r.createdAt))}
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          {r.status === "ready" || r.status === "retired" ? (
            <Button size="sm" onClick={onActivate} disabled={busy || !usable || r.deleteQueued}>
              Activate
            </Button>
          ) : null}
          {usable ? (
            <Button size="sm" variant="outline" onClick={onMove} disabled={busy || r.deleteQueued}>
              Move workspaces
            </Button>
          ) : null}
          {r.status === "ready" ? (
            <ConfirmDialog
              trigger={
                <Button size="sm" variant="outline" disabled={busy}>
                  Retire
                </Button>
              }
              title={`Retire ${r.t3Ref}?`}
              description="It stays on disk, but cannot be pinned or activated until you reactivate it. You can delete it afterwards."
              confirmLabel="Retire image"
              onConfirm={() => run(() => retireImage(r.id), "Image retired")}
            />
          ) : null}
          {canDelete ? (
            <DeleteControl
              r={r}
              busy={busy}
              moveTarget={moveTarget}
              onMove={onMoveThem}
              onDone={() => router.refresh()}
            />
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-meta text-muted-foreground">
        {r.imageId ? (
          <span>
            Image ID <Mono className="text-foreground">{shortImageId(r.imageId)}</Mono>
          </span>
        ) : null}
        {r.imageId ? <UsageLine usage={r.usage} /> : null}
        {r.status === "retired" && !r.rootfsPresent ? <span>Files deleted</span> : null}
        {r.deleteQueued ? <Badge variant="outline">Delete queued</Badge> : null}
        {r.status === "building" || r.status === "failed" ? null : <ScanBadges scan={r.scan} />}
      </div>
      {r.lastDeleteError ? (
        <p className="text-meta text-destructive">Last delete failed: {r.lastDeleteError}</p>
      ) : null}
      {r.overrideReason ? (
        <p className="text-meta text-muted-foreground">
          Activated with an override: {r.overrideReason}
        </p>
      ) : null}
      {r.versions ? (
        <details className="group text-meta">
          <summary className="w-fit cursor-pointer rounded-md text-signal hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            Versions in this image
          </summary>
          <dl className="mt-2 grid max-w-xl gap-x-6 gap-y-1 sm:grid-cols-[8rem_1fr]">
            {r.versions.map((v) => (
              <div key={v.label} className="contents">
                <dt className="text-muted-foreground">{v.label}</dt>
                <dd className="break-words">
                  <Mono>{v.value}</Mono>
                </dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
      {r.status === "failed" && r.buildLog ? (
        <details className="text-meta">
          <summary className="w-fit cursor-pointer rounded-md text-signal hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            Build log
          </summary>
          <div className="mt-2">
            <CodeBlock text={r.buildLog} label="Build log" maxHeight="16rem" wrap />
          </div>
        </details>
      ) : null}
    </li>
  );
}

export function ImagesPanel({
  rows,
  workspaces,
}: {
  rows: ImageRow[];
  workspaces: WorkspaceImageRef[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [t3Ref, setT3Ref] = useState("omp-overlay");
  const [activating, setActivating] = useState<ImageRow | null>(null);
  const [moving, setMoving] = useState<{ target: ImageRow; preselect: string[] | null } | null>(
    null,
  );
  const building = rows.filter((r) => r.status === "building");
  const activeRow = rows.find((r) => r.status === "active") ?? null;

  return (
    <>
      <Section
        title="Build a new image"
        description="Builds take several minutes. Only one build can run at a time."
      >
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              const res = await buildImage(t3Ref);
              if (!res.ok) toast.error(res.error);
              else {
                toast.success("Build queued");
                router.refresh();
              }
            });
          }}
        >
          <div className="w-full space-y-1.5 sm:w-80">
            <Label htmlFor="t3ref">T3 ref (branch, tag or commit)</Label>
            <Input
              id="t3ref"
              value={t3Ref}
              onChange={(e) => setT3Ref(e.target.value)}
              className="font-mono"
            />
          </div>
          <Button type="submit" disabled={pending || building.some((r) => !isStale(r))}>
            Build image
          </Button>
        </form>
        {building.map((r) => (
          <div key={r.id} className="mt-5 space-y-2">
            <p className="text-sm font-medium">
              Building <Mono>{r.t3Ref}</Mono>
            </p>
            <BuildLog id={r.id} initial={r.buildLog} />
          </div>
        ))}
      </Section>

      <Section title="Images" bodyClassName="p-0">
        {rows.length === 0 ? (
          <div className="p-5">
            <EmptyState
              title="No images yet"
              description="Build one above so workspaces can start."
            />
          </div>
        ) : (
          <ul className="divide-y">
            {rows.map((r) => (
              <ImageEntry
                key={r.id}
                r={r}
                busy={pending}
                moveTarget={activeRow}
                onActivate={() => setActivating(r)}
                onMove={() => setMoving({ target: r, preselect: null })}
                onMoveThem={(target, slugs) => setMoving({ target, preselect: slugs })}
              />
            ))}
          </ul>
        )}
      </Section>
      {activating ? (
        <ActivateDialog
          row={activating}
          workspaces={workspaces}
          onClose={() => setActivating(null)}
        />
      ) : null}
      {moving ? (
        <MoveDialog
          target={moving.target}
          rows={rows}
          workspaces={workspaces}
          preselect={moving.preselect}
          onClose={() => setMoving(null)}
        />
      ) : null}
    </>
  );
}
