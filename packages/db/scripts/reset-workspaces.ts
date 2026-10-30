// Admin maintenance: delete ALL workspaces and send every user back through onboarding.
//
//   DATABASE_URL=postgres://... node scripts/reset-workspaces.ts --keep-data   # dry run
//   DATABASE_URL=postgres://... node scripts/reset-workspaces.ts --wipe --yes  # really queue it
//
// Exactly one of --keep-data / --wipe is required. Without --yes only a report is printed.
// The worker performs the deletions (delete_tenant jobs); see docs/onboarding.md.
import { resetAllWorkspaces } from "../src/admin.ts";
import { db } from "../src/client.ts";

const args = new Set(process.argv.slice(2));
const keep = args.has("--keep-data");
const wipe = args.has("--wipe");
if (keep === wipe) {
  console.error("Pass exactly one of --keep-data or --wipe (add --yes to execute).");
  process.exit(2);
}

const dryRun = !args.has("--yes");
const result = await resetAllWorkspaces(db, { keepData: keep, dryRun });
console.log(
  `${dryRun ? "[dry run] would delete" : "queued deletion of"} ${result.workspaces.length} workspace(s) ` +
    `(${keep ? "keeping" : "wiping"} data) and reset onboarding for ${result.usersReset} user(s).`,
);
for (const w of result.workspaces) console.log(`  ${w.slug} (${w.status})`);
if (dryRun) console.log("Nothing changed. Re-run with --yes to execute.");
process.exit(0);
