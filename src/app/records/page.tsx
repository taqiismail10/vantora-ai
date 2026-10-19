import type { Metadata } from "next";
import { Suspense } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";

import { RecordsWorkspace } from "@/components/vantora/records-workspace";
import { requireSession } from "@/lib/server/identity";

export const metadata: Metadata = { title: "Records — Vantora AI" };

export default function RecordsPage() {
  return (
    <Suspense fallback={null}>
      <Records />
    </Suspense>
  );
}

async function Records() {
  await connection();
  const session = await requireSession(new Request("http://internal/", { headers: await headers() })).catch(() => null);
  if (!session) redirect("/login");
  return <RecordsWorkspace />;
}
