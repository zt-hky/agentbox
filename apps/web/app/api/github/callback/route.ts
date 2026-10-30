import { handleGitCallback } from "@/lib/git-callback";

/** The dedicated GitHub OAuth App's registered callback. */
export const GET = (request: Request) => handleGitCallback("github", request);
