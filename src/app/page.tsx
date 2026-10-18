import { Suspense } from "react";
import { connection } from "next/server";

import { VantoraDashboard } from "@/components/vantora/dashboard";
import { buildDashboardState } from "@/lib/dashboard-data";

export default function Home() {
  return (
    <Suspense fallback={<Booting />}>
      <Workspace />
    </Suspense>
  );
}

async function Workspace() {
  // The forecast, the optimiser and the audit chain are all per-request state,
  // so this subtree must never be prerendered.
  await connection();
  return <VantoraDashboard initial={await buildDashboardState()} />;
}

function Booting() {
  return (
    <div className="flex flex-1 items-center justify-center bg-slate-50 p-16 text-sm text-slate-500 dark:bg-slate-950">
      Running the Monte Carlo forecast and the MILP optimiser...
    </div>
  );
}
