"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, FolderGit2, GitBranch, Plus, Server } from "lucide-react";
import { toast } from "sonner";
import { gitTokenPageUrl, gitTokenScopesHint } from "@agentbox/core/git";
import { addGitTokenAccount, disconnectGitAccount } from "@/app/(app)/settings/accounts/actions";
import { CodeBlock } from "@/components/code-block";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Mono } from "@/components/mono";
import { Notice } from "@/components/notice";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { GitAccountsView, GitConnectionView, GitProviderCard } from "@/lib/git-accounts";
import { cn } from "@/lib/utils";

type TokenProvider = "gitlab" | "gitlab-self" | "gitea" | "generic";

const ERRORS: Record<string, string> = {
  state: "The sign-in expired or came from another browser tab. Start the connection again.",
  exchange: "The host did not finish the connection. Try again in a moment.",
  denied: "Access was denied at the host. Connect again and approve it to continue.",
};

const PROVIDER_LABELS: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
  "gitlab-self": "GitLab",
  gitea: "Gitea / Forgejo",
  generic: "Git host",
};

function HostIcon({ provider, host }: { provider: string; host: string }) {
  const cls = "size-5 shrink-0 text-muted-foreground";
  if (provider === "gitlab" || provider === "gitlab-self" || host === "gitlab.com") {
    return <FolderGit2 className={cls} aria-hidden />;
  }
  if (provider === "github" || provider === "bitbucket" || host === "github.com") {
    return <GitBranch className={cls} aria-hidden />;
  }
  return <Server className={cls} aria-hidden />;
}

/** Provider used when a token (not OAuth) is saved for a host. */
function tokenProviderFor(provider: string): TokenProvider {
  return provider === "gitlab" || provider === "gitlab-self" || provider === "gitea"
    ? provider
    : "generic";
}

interface TokenTarget {
  provider: TokenProvider;
  /** Bare hostname; empty means the user types it. */
  host: string;
  /** Provider and host cannot be edited (preset cards, token updates). */
  fixed: boolean;
  username: string;
  title: string;
  tokenUrl: string | null;
  scopes: string | null;
}

function selfHostedTarget(): TokenTarget {
  return {
    provider: "gitlab-self",
    host: "",
    fixed: false,
    username: "",
    title: "Add a self-hosted or other git host",
    tokenUrl: null,
    scopes: null,
  };
}

function cardTarget(card: GitProviderCard): TokenTarget {
  return {
    provider: card.id === "gitlab" ? "gitlab" : "generic",
    host: card.host,
    fixed: true,
    username: "",
    title: `Connect ${card.label} with a token`,
    tokenUrl: card.tokenUrl,
    scopes: card.tokenScopes,
  };
}

function updateTarget(conn: GitConnectionView, cards: GitProviderCard[]): TokenTarget {
  const card = cards.find((c) => c.host === conn.host);
  return {
    provider: tokenProviderFor(conn.provider),
    host: conn.host,
    fixed: true,
    username: conn.login,
    title: `Update token for ${conn.host}`,
    tokenUrl: card?.tokenUrl ?? gitTokenPageUrl(tokenProviderFor(conn.provider), conn.host),
    scopes: card?.tokenScopes ?? gitTokenScopesHint(tokenProviderFor(conn.provider), conn.host),
  };
}

function connectHref(card: GitProviderCard, next: "onboarding" | "settings", workflow = false) {
  const params = new URLSearchParams();
  if (next === "onboarding") params.set("next", "/onboarding");
  if (workflow) params.set("workflow", "1");
  const qs = params.toString();
  return qs ? `${card.connectUrl}?${qs}` : card.connectUrl;
}

function TokenDialog({ target, onClose }: { target: TokenTarget; onClose: () => void }) {
  const router = useRouter();
  const [provider, setProvider] = useState<TokenProvider>(target.provider);
  const [host, setHost] = useState(target.host);
  const [username, setUsername] = useState(target.username);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const hostless = provider === "gitlab" && target.fixed;
  const typedHost = host.trim().toLowerCase();
  const tokenUrl = target.fixed
    ? target.tokenUrl
    : provider === "generic" || !typedHost
      ? null
      : gitTokenPageUrl(provider, typedHost);
  const scopes = target.fixed ? target.scopes : gitTokenScopesHint(provider, typedHost);
  const ready = (hostless || host.trim()) && username.trim() && token.trim();

  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{target.title}</DialogTitle>
          <DialogDescription>
            Paste a personal access token. It is verified against the host, stored encrypted and
            used for git over HTTPS. Your workspace SSH key is added to the account when the host
            allows it.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!ready) return;
            start(async () => {
              setError(null);
              const res = await addGitTokenAccount({
                provider,
                host: hostless ? "gitlab.com" : host.trim().toLowerCase(),
                username: username.trim(),
                token: token.trim(),
              });
              if (!res.ok) {
                setError(res.error);
                return;
              }
              toast.success("Account connected");
              onClose();
              router.refresh();
            });
          }}
        >
          {!target.fixed ? (
            <div className="grid gap-1.5">
              <Label htmlFor="git-provider">Type</Label>
              <Select value={provider} onValueChange={(v) => setProvider(v as TokenProvider)}>
                <SelectTrigger id="git-provider" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="gitlab-self">GitLab (self-managed)</SelectItem>
                  <SelectItem value="gitea">Gitea / Forgejo</SelectItem>
                  <SelectItem value="generic">Other (any HTTPS git host)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}
          {!hostless ? (
            <div className="grid gap-1.5">
              <Label htmlFor="git-host">Host</Label>
              <Input
                id="git-host"
                className="font-mono"
                placeholder="git.example.com"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                value={host}
                readOnly={target.fixed}
                onChange={(e) => setHost(e.target.value)}
              />
              {!target.fixed ? (
                <p className="text-meta text-muted-foreground">
                  Hostname only, served over https. No IP addresses or localhost.
                </p>
              ) : null}
            </div>
          ) : null}
          <div className="grid gap-1.5">
            <Label htmlFor="git-username">Username</Label>
            <Input
              id="git-username"
              className="font-mono"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="git-token">Token</Label>
            <Input
              id="git-token"
              type="password"
              className="font-mono"
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <p className="text-meta text-muted-foreground">
              {scopes ? (
                <>
                  Needs <Mono>{scopes}</Mono>.{" "}
                </>
              ) : (
                "Needs permission to read and write repositories. "
              )}
              {tokenUrl ? (
                <a
                  href={tokenUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 underline underline-offset-4"
                >
                  Create a token
                  <ExternalLink className="size-3" aria-hidden />
                </a>
              ) : null}
            </p>
          </div>
          {error ? <Notice tone="error">{error}</Notice> : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !ready}>
              {pending ? "Verifying…" : "Connect"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Chip({ ok, children }: { ok?: boolean; children: React.ReactNode }) {
  return (
    <Badge variant="outline" className={cn(ok ? "text-status-ok" : "text-muted-foreground")}>
      {children}
    </Badge>
  );
}

function ConnectionRow({
  conn,
  cards,
  next,
  onUpdateToken,
}: {
  conn: GitConnectionView;
  cards: GitProviderCard[];
  next: "onboarding" | "settings";
  onUpdateToken: (t: TokenTarget) => void;
}) {
  const router = useRouter();
  const card = cards.find((c) => c.host === conn.host && c.id === conn.provider);
  const oauth = conn.method === "oauth";
  const errored = conn.status === "error";

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0">
      <HostIcon provider={conn.provider} host={conn.host} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-mono text-sm">
            {conn.login}@{conn.host}
          </span>
          <StatusBadge
            status={errored ? "error" : "active"}
            label={errored ? "Needs attention" : "Connected"}
          />
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Chip ok>HTTPS ✓</Chip>
          {conn.ssh === "uploaded" ? <Chip ok>SSH ✓</Chip> : null}
          {conn.ssh === "manual" ? <Chip>SSH: add the workspace key below</Chip> : null}
          {conn.ssh === "pending" ? <Chip>SSH pending</Chip> : null}
          {conn.ssh === "reconnect" ? <Chip>SSH off</Chip> : null}
          <span className="text-meta text-muted-foreground">
            {PROVIDER_LABELS[conn.provider] ?? conn.provider} · {oauth ? "OAuth" : "Access token"}
          </span>
        </div>
        {errored ? (
          <p className="mt-1.5 text-meta text-destructive">
            {conn.lastError ?? "The host rejected the saved credentials."}
          </p>
        ) : null}
        {conn.provider === "github" && oauth && next === "settings" && !conn.workflowScope ? (
          <p className="mt-1.5 text-meta text-muted-foreground">
            Pushes that change .github/workflows are rejected.{" "}
            {card ? (
              <a href={connectHref(card, next, true)} className="underline underline-offset-4">
                Allow editing workflows
              </a>
            ) : null}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {conn.ssh === "reconnect" && card ? (
          <Button asChild variant="outline" size="sm">
            <a href={connectHref(card, next)}>Reconnect to enable SSH</a>
          </Button>
        ) : oauth && card ? (
          errored ? (
            <Button asChild variant="outline" size="sm">
              <a href={connectHref(card, next)}>Reconnect</a>
            </Button>
          ) : null
        ) : null}
        {!oauth ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onUpdateToken(updateTarget(conn, cards))}
          >
            {errored ? "Reconnect with a new token" : "Update token"}
          </Button>
        ) : null}
        <ConfirmDialog
          trigger={
            <Button variant="outline" size="sm">
              Disconnect
            </Button>
          }
          title={`Disconnect ${conn.host}?`}
          description={
            conn.provider === "github"
              ? "The token is revoked and the workspace SSH key is removed from your GitHub account where possible. gh is logged out in your workspace, and a Copilot sign-in made from the Accounts page is signed out as well."
              : "Saved credentials are removed from your workspace and the workspace SSH key is removed from your account on this host where possible."
          }
          confirmLabel="Disconnect"
          destructive
          onConfirm={async () => {
            const res = await disconnectGitAccount(conn.id);
            if (res.ok) {
              toast.success(`${conn.host} disconnected`);
              router.refresh();
            }
            return res;
          }}
        />
      </div>
    </li>
  );
}

function ProviderCard({
  card,
  connected,
  next,
  onToken,
}: {
  card: GitProviderCard;
  connected: boolean;
  next: "onboarding" | "settings";
  onToken: (t: TokenTarget) => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2">
        <HostIcon provider={card.id} host={card.host} />
        <div className="min-w-0">
          <h3 className="text-base">{card.label}</h3>
          <p className="font-mono text-meta text-muted-foreground">{card.host}</p>
        </div>
      </div>
      {connected ? (
        <StatusBadge status="active" label="Connected" />
      ) : card.oauthConfigured ? (
        <Button asChild className="mt-auto">
          <a href={connectHref(card, next)}>Connect {card.label}</a>
        </Button>
      ) : (
        <>
          <p className="text-meta text-muted-foreground">Not configured by the administrator.</p>
          <Button variant="outline" className="mt-auto" onClick={() => onToken(cardTarget(card))}>
            Use a token instead
          </Button>
        </>
      )}
    </div>
  );
}

/**
 * Git hosts the workspace can clone, pull and push to over HTTPS and SSH. Shared by the
 * onboarding Accounts step (`next="onboarding"`) and the Accounts page (`next="settings"`).
 */
export function GitAccounts({
  view,
  next,
  error,
  connected,
}: {
  view: GitAccountsView;
  next: "onboarding" | "settings";
  /** `?error=` code from the OAuth return. */
  error?: string | null;
  /** `?connected=` provider id from the OAuth return. */
  connected?: string | null;
}) {
  const [target, setTarget] = useState<TokenTarget | null>(null);
  const connectedHosts = new Set(view.connections.map((c) => c.host));
  const showKey = view.workspaceSshPublicKey !== null || view.connections.length > 0;
  const needsManualKey = view.connections.some((c) => c.ssh === "manual");

  return (
    <div className="space-y-4">
      {error ? (
        <Notice tone="error">{ERRORS[error] ?? "The connection failed. Try again."}</Notice>
      ) : connected ? (
        <Notice>
          {PROVIDER_LABELS[connected] ?? "The account"} is connected. Your workspace picks it up
          within a minute.
        </Notice>
      ) : null}

      {view.connections.length > 0 ? (
        <ul className="divide-y rounded-lg border bg-card p-5" aria-label="Connected accounts">
          {view.connections.map((conn) => (
            <ConnectionRow
              key={conn.id}
              conn={conn}
              cards={view.providers}
              next={next}
              onUpdateToken={setTarget}
            />
          ))}
        </ul>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        {view.providers.map((card) => (
          <ProviderCard
            key={card.id}
            card={card}
            connected={connectedHosts.has(card.host)}
            next={next}
            onToken={setTarget}
          />
        ))}
      </div>

      <Button variant="outline" onClick={() => setTarget(selfHostedTarget())}>
        <Plus />
        Add self-hosted or other host
      </Button>

      {showKey ? (
        <div className="space-y-2 rounded-lg border bg-card p-5">
          <div>
            <h3 className="text-base">Workspace SSH key</h3>
            <p className="text-meta text-muted-foreground">
              {needsManualKey
                ? "Add this public key to your account on the hosts marked above. For the others it is uploaded for you."
                : "Uploaded to your connected accounts automatically. Use it to add the workspace to a host by hand."}
            </p>
          </div>
          {view.workspaceSshPublicKey ? (
            <CodeBlock text={view.workspaceSshPublicKey} wrap label="Workspace SSH public key" />
          ) : (
            <p className="text-sm text-muted-foreground">
              {view.hasWorkspace
                ? "The key is created the first time the workspace syncs. Check back in a minute."
                : "The key is created with your workspace."}
            </p>
          )}
        </div>
      ) : null}

      {target ? (
        <TokenDialog
          key={`${target.provider}:${target.host}`}
          target={target}
          onClose={() => setTarget(null)}
        />
      ) : null}
    </div>
  );
}
