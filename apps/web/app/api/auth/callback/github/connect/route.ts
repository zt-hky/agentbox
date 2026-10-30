// Static route: wins over the better-auth catch-all `app/api/auth/[...all]`. Used when Connect
// reuses the sign-in OAuth App, whose registered callback is `/api/auth/callback/github`.
export { handleGithubCallback as GET } from "@/lib/github-callback";
