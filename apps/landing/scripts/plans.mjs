/* global console, process, URL */
// Refreshes src/data/plans.json from the production database when DATABASE_URL is set.
// Without it the checked-in snapshot is used as-is (a build must work offline).
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const file = fileURLToPath(new URL("../src/data/plans.json", import.meta.url));
const url = process.env.DATABASE_URL;

if (!url) {
  const snap = JSON.parse(await readFile(file, "utf8"));
  console.log(
    `plans: DATABASE_URL not set, using checked-in snapshot (${snap.plans.length} plans, ${snap.fetchedAt})`,
  );
  process.exit(0);
}

const { default: pg } = await import("pg");
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const plans = (await client.query("select * from plans where active")).rows;
  const price = (await client.query("select * from prices order by effective_from desc limit 1"))
    .rows[0];
  const billing =
    (await client.query("select value from settings where key = 'billing'")).rows[0]?.value ?? {};
  const order = { free: 0, payg: 1, package: 2 };
  plans.sort(
    (a, b) =>
      (order[a.kind] ?? 9) - (order[b.kind] ?? 9) ||
      Number(a.monthly_price_micro) - Number(b.monthly_price_micro),
  );
  const out = {
    source: "database",
    fetchedAt: new Date().toISOString().slice(0, 10),
    creditLabel: billing.creditLabel ?? "credit",
    prices: {
      runtimePerHour: Number(price.runtime_per_hour),
      cpuCorePerHour: Number(price.cpu_core_per_hour),
      memGbPerHour: Number(price.mem_gb_per_hour),
    },
    plans: plans.map((p) => ({
      name: p.name,
      kind: p.kind,
      monthlyPriceMicro: Number(p.monthly_price_micro),
      cpu: Number(p.cpu_limit),
      memoryMb: p.memory_limit_mb,
      diskGb: p.disk_limit_gb,
      pids: p.pids_limit,
      allowanceRuntimeHours: Number(p.allowance_runtime_hours),
      allowanceCpuCoreHours: Number(p.allowance_cpu_core_hours),
      allowanceMemGbHours: Number(p.allowance_mem_gb_hours),
    })),
  };
  await writeFile(file, JSON.stringify(out, null, 2) + "\n");
  console.log(`plans: refreshed ${out.plans.length} plans from the database`);
} finally {
  await client.end();
}
