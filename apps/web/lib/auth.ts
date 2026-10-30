import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { admin } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { db } from "@agentbox/db/client";
import { account, session, user, verification } from "@agentbox/db/schema";
import { openAccessRequest } from "./approve";
import { appOrigin, bootstrapAdminEmails } from "./env";

function createAuth() {
  const origin = appOrigin();
  const googleId = process.env.GOOGLE_CLIENT_ID;
  const googleSecret = process.env.GOOGLE_CLIENT_SECRET;
  const githubId = process.env.GITHUB_CLIENT_ID;
  const githubSecret = process.env.GITHUB_CLIENT_SECRET;

  return betterAuth({
    baseURL: origin,
    secret: process.env.BETTER_AUTH_SECRET,
    trustedOrigins: [origin],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user, session, account, verification },
    }),
    user: {
      additionalFields: {
        accessStatus: {
          type: "string",
          required: false,
          defaultValue: "none",
          input: false,
        },
        onboardedAt: {
          type: "date",
          required: false,
          input: false,
        },
      },
    },
    socialProviders: {
      ...(googleId && googleSecret
        ? { google: { clientId: googleId, clientSecret: googleSecret } }
        : {}),
      ...(githubId && githubSecret
        ? {
            github: {
              clientId: githubId,
              clientSecret: githubSecret,
              scope: ["read:user", "user:email"],
            },
          }
        : {}),
    },
    account: {
      accountLinking: { enabled: true, trustedProviders: ["google", "github"] },
    },
    advanced: {
      // All cookies are `__Host-` prefixed (Secure, Path=/, no Domain). better-auth only emits
      // `__Secure-` when `useSecureCookies` is true, so the prefix is supplied via `cookiePrefix`
      // and Secure through the default attributes instead. `crossSubDomainCookies` stays off.
      useSecureCookies: false,
      cookiePrefix: "__Host-abx",
      defaultCookieAttributes: { secure: true, sameSite: "lax", path: "/" },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"] },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (created) => {
            const email = created.email.toLowerCase();
            if (created.emailVerified && bootstrapAdminEmails().includes(email)) {
              await db
                .update(user)
                .set({ role: "admin", accessStatus: "active" })
                .where(eq(user.id, created.id));
              return;
            }
            // Everyone else is queued for review immediately; the request page then only waits.
            await openAccessRequest(db, created.id);
          },
        },
      },
    },
    plugins: [admin({ defaultRole: "user", adminRoles: ["admin"] }), nextCookies()],
  });
}

type Auth = ReturnType<typeof createAuth>;
let instance: Auth | undefined;

/** Lazy: constructing at import time would require production env during `next build`. */
export function getAuth(): Auth {
  instance ??= createAuth();
  return instance;
}
