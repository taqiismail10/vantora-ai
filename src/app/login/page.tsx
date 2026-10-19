import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { LoginForm } from "@/components/vantora/login-form";
import { getAuth } from "@/lib/server/auth";
import { currentActor } from "@/lib/server/identity";

export const metadata: Metadata = { title: "Sign in — Vantora AI" };

export default function LoginPage({ searchParams }: { searchParams: Promise<{ reason?: string }> }) {
  return (
    <Suspense fallback={null}>
      <Login searchParams={searchParams} />
    </Suspense>
  );
}

async function Login({ searchParams }: { searchParams: Promise<{ reason?: string }> }) {
  await connection();
  if (await currentActor(await headers())) redirect("/");
  const configured = (await getAuth()) !== null;
  const { reason } = await searchParams;
  return (
    <main className="flex min-h-full flex-1 items-center justify-center bg-slate-50 p-4 dark:bg-slate-950">
      <LoginForm configured={configured} reason={reason ?? null} />
    </main>
  );
}
