import Link from "next/link";
import { Meter } from "@/components/meter";
import { Mono } from "@/components/mono";
import { StatusLight, describeWorkspaceStatus, statusLabel } from "@/components/status-light";
import { formatAgo, formatBytes, formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface WorkspaceModuleData {
  slug: string;
  status: string;
  /** Owner email or name (admin views). */
  owner?: string | null;
  plan?: string | null;
  lastActivityAt?: Date | null;
  /** Set while awake; used for the uptime readout. */
  awakeSince?: Date | null;
  /** Effective idle-sleep timeout; shown in the hero while the workspace is awake. */
  idleTimeoutMinutes?: number | null;
}

/** Live readings; `null` per field when unknown. CPU in cores, memory and disk in bytes. */
export interface WorkspaceLive {
  cpuCores: number | null;
  memBytes: number | null;
  diskBytes: number | null;
}

export interface WorkspaceLimits {
  cpus: number;
  memBytes: number;
  diskBytes: number;
}

interface Props {
  ws: WorkspaceModuleData;
  variant: "hero" | "row";
  /** Live readings; shown only while the workspace is running. */
  live?: WorkspaceLive | null;
  limits?: WorkspaceLimits | null;
  /** Hostname shown on the name plate (hero). Defaults to the slug. */
  host?: string;
  /** Hero: state sentence override. */
  stateText?: string;
  /** Buttons, right side of the hero / end of the row. */
  actions?: React.ReactNode;
  /** Row: whole-row link target (e.g. admin detail page). */
  href?: string;
  now?: Date;
  className?: string;
}

const cores = (v: number, m: number) => `${v.toFixed(2)} / ${+m.toFixed(2)} cores`;
const bytes = (v: number, m: number) => `${formatBytes(v)} / ${formatBytes(m)}`;

function Meters({
  live,
  limits,
  compact,
  idle,
}: {
  live: WorkspaceLive | null | undefined;
  limits: WorkspaceLimits | null | undefined;
  compact: boolean;
  idle: boolean;
}) {
  const l = idle ? null : live;
  const emptyText = idle ? "not running" : "no data";
  return (
    <>
      <Meter
        label="CPU"
        compact={compact}
        emptyText={emptyText}
        value={l?.cpuCores ?? null}
        max={limits?.cpus ?? 1}
        format={limits ? cores : (v) => `${v.toFixed(2)} cores`}
      />
      <Meter
        label="Memory"
        compact={compact}
        emptyText={emptyText}
        value={l?.memBytes ?? null}
        max={limits?.memBytes ?? 1}
        format={limits ? bytes : (v) => formatBytes(v)}
      />
      <Meter
        label="Disk"
        compact={compact}
        emptyText={emptyText}
        value={l?.diskBytes ?? null}
        max={limits?.diskBytes ?? 1}
        format={limits ? bytes : (v) => formatBytes(v)}
      />
    </>
  );
}

/**
 * The rack module: status light, name plate, three level meters.
 * `hero` is the large user-dashboard version; `row` is the compact admin list row.
 */
export function WorkspaceModule({
  ws,
  variant,
  live,
  limits,
  host,
  stateText,
  actions,
  href,
  now = new Date(),
  className,
}: Props) {
  const running = ws.status === "running";
  const uptime =
    running && ws.awakeSince
      ? formatDuration((now.getTime() - ws.awakeSince.getTime()) / 1000)
      : null;

  if (variant === "hero") {
    return (
      <section
        aria-label="Workspace"
        className={cn(
          "grid overflow-hidden rounded-xl border bg-card text-card-foreground shadow-module lg:grid-cols-[1fr_22rem]",
          className,
        )}
      >
        <div className="flex flex-col gap-5 p-6 md:p-7">
          <div className="flex items-center gap-3">
            <StatusLight status={ws.status} size="lg" />
            <Mono className="text-base font-medium">{host ?? ws.slug}</Mono>
            {ws.plan ? (
              <span className="rounded-md border px-1.5 py-0.5 text-xs text-muted-foreground">
                {ws.plan}
              </span>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <h2 className="max-w-lg text-xl leading-snug">
              {stateText ?? describeWorkspaceStatus(ws.status)}
            </h2>
            <p className="text-sm text-muted-foreground">
              {uptime ? `Awake for ${uptime}. ` : ""}
              Last activity {formatAgo(ws.lastActivityAt, now)}.
              {running && ws.idleTimeoutMinutes
                ? ` Sleeps after ${ws.idleTimeoutMinutes} min without activity.`
                : ""}
            </p>
          </div>
          {actions ? <div className="mt-auto flex flex-wrap gap-2">{actions}</div> : null}
        </div>
        <div className="grid content-center gap-4 border-t bg-rack p-6 lg:border-t-0 lg:border-l">
          <Meters live={live} limits={limits} compact={false} idle={!running} />
          {!running ? (
            <p className="text-meta text-muted-foreground">
              Meters switch on while the workspace is running.
            </p>
          ) : null}
        </div>
      </section>
    );
  }

  const name = (
    <span className="flex min-w-0 items-center gap-2.5">
      <StatusLight status={ws.status} />
      <Mono className="truncate font-medium">{ws.slug}</Mono>
    </span>
  );
  return (
    <div
      className={cn(
        "relative grid items-center gap-x-6 gap-y-3 rounded-lg border bg-card px-4 py-3 text-sm md:grid-cols-[minmax(10rem,1.2fr)_minmax(8rem,1fr)_repeat(3,minmax(6rem,1fr))_auto]",
        href && "hover:bg-accent/40",
        className,
      )}
    >
      <div className="min-w-0">
        {href ? (
          <Link href={href} className="after:absolute after:inset-0">
            {name}
          </Link>
        ) : (
          name
        )}
        <div className="mt-0.5 pl-[18px] text-xs text-muted-foreground">
          {statusLabel(ws.status)}
        </div>
      </div>
      <div className="min-w-0 text-meta text-muted-foreground">
        {ws.owner ? <div className="truncate text-foreground">{ws.owner}</div> : null}
        <div className="truncate">
          {[ws.plan, uptime ? `up ${uptime}` : `active ${formatAgo(ws.lastActivityAt, now)}`]
            .filter(Boolean)
            .join(", ")}
        </div>
      </div>
      <Meters live={live} limits={limits} compact idle={!running} />
      {actions ? (
        <div className="relative z-10 flex items-center gap-1.5">{actions}</div>
      ) : (
        <span />
      )}
    </div>
  );
}
