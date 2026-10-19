import type { Metadata } from "next";
import { Suspense } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";

import { Onboarding } from "@/components/vantora/onboarding";
import { requireSession } from "@/lib/server/identity";

export const metadata: Metadata = { title: "Set up your company — Vantora AI" };

export default function OnboardingPage() {
  return (
    <Suspense fallback={null}>
      <Setup />
    </Suspense>
  );
}

async function Setup() {
  await connection();
  const session = await requireSession(new Request("http://internal/", { headers: await headers() })).catch(() => null);
  if (!session) redirect("/login");
  // The component resolves which company and which step from /api/company,
  // so a resumed session lands on the step the owner left off at.
  return <Onboarding />;
}
