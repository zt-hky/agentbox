import { Button } from "@/components/ui/button";
import { Notice } from "@/components/notice";
import { signInWithProvider } from "@/app/login/actions";
import { cn } from "@/lib/utils";
import type { LoginProvider } from "@/lib/env";

const PROVIDERS: Record<LoginProvider, { label: string; icon: React.ReactNode }> = {
  github: {
    label: "Continue with GitHub",
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.76 2.69 1.25 3.35.96.1-.74.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.18-3.09-.12-.29-.51-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.62 1.59.23 2.76.11 3.05.74.81 1.18 1.83 1.18 3.09 0 4.42-2.7 5.4-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z"
          fill="currentColor"
        />
      </svg>
    ),
  },
  google: {
    label: "Continue with Google",
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z"
          fill="currentColor"
        />
      </svg>
    ),
  },
};

export function LoginForm({
  providers,
  next,
  error,
  className,
}: {
  providers: LoginProvider[];
  next: string;
  error?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-6", className)}>
      <div className="space-y-1.5">
        <h1 className="text-title">Sign in</h1>
        <p className="text-sm text-muted-foreground">
          Open your workspace, or request one if you are new here.
        </p>
      </div>
      {providers.length === 0 ? (
        <Notice tone="error">
          No sign-in provider is configured. Set GitHub or Google credentials in the server
          environment.
        </Notice>
      ) : (
        <form action={signInWithProvider} className="flex flex-col gap-3">
          <input type="hidden" name="next" value={next} />
          {error ? (
            <Notice tone="error">
              Sign-in did not complete. Try again, or use another provider.
            </Notice>
          ) : null}
          {providers.map((p) => (
            <Button key={p} variant="outline" size="lg" type="submit" name="provider" value={p}>
              {PROVIDERS[p].icon}
              {PROVIDERS[p].label}
            </Button>
          ))}
        </form>
      )}
      <p className="text-meta text-muted-foreground">
        New accounts are reviewed by an administrator before they can create a workspace.
      </p>
    </div>
  );
}
