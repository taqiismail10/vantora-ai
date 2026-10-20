import type { Metadata } from "next";
import { Suspense } from "react";

import { AcceptInviteForm } from "@/components/vantora/accept-invite-form";

export const metadata: Metadata = { title: "Accept invitation — Vantora AI" };

export default function AcceptInvitePage() {
  return (
    <main className="flex min-h-full flex-1 items-center justify-center bg-slate-50 p-4 dark:bg-slate-950">
      <Suspense fallback={null}>
        <AcceptInviteForm />
      </Suspense>
    </main>
  );
}
