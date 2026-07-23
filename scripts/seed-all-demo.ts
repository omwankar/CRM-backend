/**
 * Combined demo seed: Sales → Ops → Finance.
 *
 * Usage (from backend/):
 *   npx tsx scripts/seed-all-demo.ts
 *   npx tsx scripts/seed-all-demo.ts --clear
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLEAR_ONLY = process.argv.includes("--clear");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, "..");

const scripts = CLEAR_ONLY
  ? [
      // Finance first (depends on sales buyers for soft links)
      "seed-finance-demo.ts",
      "seed-ops-demo.ts",
      "seed-sales-demo.ts",
    ]
  : ["seed-sales-demo.ts", "seed-ops-demo.ts", "seed-finance-demo.ts"];

function run(script: string) {
  const args = ["tsx", path.join("scripts", script)];
  if (CLEAR_ONLY) args.push("--clear");
  console.log(`\n========== ${CLEAR_ONLY ? "CLEAR" : "SEED"} ${script} ==========\n`);
  const result = spawnSync("npx", args, {
    cwd: backendRoot,
    stdio: "inherit",
    shell: true,
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

for (const s of scripts) run(s);

console.log(
  CLEAR_ONLY
    ? "\nAll demo seeds cleared (Finance, Ops, Sales)."
    : "\nAll demo seeds complete: Sales + Ops + Finance.",
);
console.log(
  CLEAR_ONLY
    ? "  Re-seed with: npm run seed:all"
    : "  Clear with: npm run seed:all:clear",
);
