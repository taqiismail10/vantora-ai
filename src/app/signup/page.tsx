import type { Metadata } from "next";
import { Suspense } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";

import { SignupForm } from "@/components/vantora/signup-form";
import { getAuth, publicSignupEnabled } from "@/lib/server/auth";
import { requireSession } from "@/lib/server/identity";

export const metadata: Metadata = { title: "Create an account — Vantora AI" };

export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <Signup />
    </Suspense>
  );
}

async function Signup() {
  await connection();
  if (!publicSignupEnabled()) redirect("/login");
  // Already signed in: there is nothing to create here.
  const session = await requireSession(new Request("http://internal/", { headers: await headers() })).catch(() => null);
  if (session) redirect("/onboarding");
  return (
    <main className="flex min-h-full flex-1 items-center justify-center bg-slate-50 p-4 dark:bg-slate-950">
      <SignupForm configured={(await getAuth()) !== null} />
    </main>
  );
}
