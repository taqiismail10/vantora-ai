"use client";

/**
 * Staff invitations and membership — owner only.
 *
 * No email is sent by this server: inviting someone produces a copyable
 * link, shown once, that the owner shares however they choose. The link is
 * bound to the email it names and expires in 7 days; accepting it requires
 * a signed-in session whose own email matches.
 */

import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { companyAction, type InvitationRow, type MemberRow } from "./company-api";
import { Field, FormShell, INPUT, useSubmit } from "./company-forms";

const ROLES = [
  { value: "VIEWER", label: "Viewer — read only" },
  { value: "ANALYST", label: "Analyst — can draft, not approve" },
  { value: "OWNER", label: "Owner — full control" },
] as const;

function InviteForm({ onSaved }: { onSaved: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<(typeof ROLES)[number]["value"]>("ANALYST");
  const [link, setLink] = useState<string | null>(null);
  const { busy, error, run } = useSubmit(onSaved);

  return (
    <FormShell
      title="Invite someone to this company"
      description="Produces a link, shown once below, that you copy and share yourself — this server never sends it."
      error={error}
      busy={busy}
      submitLabel="Create invitation"
      onSubmit={() =>
        run(
          async () => {
            const result = await companyAction<{ inviteLink: string }>("invite_member", { email, memberRole: role });
            setLink(result.inviteLink);
            return result;
          },
          () => setEmail(""),
        )
      }
    >
      <Field label="Email" required>
        {(id) => <input id={id} type="email" className={INPUT} value={email} onChange={(e) => setEmail(e.target.value)} />}
      </Field>
      <Field label="Role" required>
        {(id) => (
          <select id={id} className={INPUT} value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
            {ROLES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        )}
      </Field>
      {link ? (
        <div className="col-span-full rounded-md border border-emerald-300 bg-emerald-50 p-2 text-[11px] text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
          <p className="mb-1 font-medium">Shown once — copy it now:</p>
          <code className="break-all">{link}</code>
        </div>
      ) : null}
    </FormShell>
  );
}

export function MembershipSection({
  members,
  invitations,
  selfUserId,
  onChanged,
}: {
  members: MemberRow[];
  invitations: InvitationRow[];
  selfUserId: string;
  onChanged: () => void;
}) {
  const owners = members.filter((m) => m.role === "OWNER").length;
  return (
    <div className="flex flex-col gap-3">
      <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-slate-800/60 dark:border-slate-800">
        {members.map((m) => {
          const lastOwner = m.role === "OWNER" && owners <= 1;
          return (
            <li key={m.userId} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
              <span className="min-w-0 flex-1">
                <span className="font-medium text-slate-900 dark:text-slate-100">{m.name || m.email}</span>
                <span className="ml-2 text-slate-500 dark:text-slate-400">{m.email}</span>
              </span>
              {m.userId === selfUserId ? (
                <Badge variant="outline" className="font-mono text-[10px]">
                  you
                </Badge>
              ) : null}
              <select
                className={INPUT + " h-7 w-auto py-0 text-[11px]"}
                value={m.role}
                disabled={lastOwner}
                aria-disabled={lastOwner}
                aria-label={`Role for ${m.name || m.email}`}
                title={lastOwner ? "The only owner cannot be demoted — promote someone else first" : undefined}
                onChange={(e) => void companyAction("set_member_role", { memberId: m.userId, memberRole: e.target.value }).then(onChanged)}
              >
                {ROLES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={lastOwner}
                aria-disabled={lastOwner}
                title={lastOwner ? "The only owner cannot be removed — promote someone else first" : undefined}
                className="h-7 px-1.5 text-[11px] text-rose-700 dark:text-rose-300"
                onClick={() => void companyAction("remove_member", { memberId: m.userId }).then(onChanged)}
              >
                Remove
              </Button>
              {lastOwner ? (
                <span className="w-full text-[10px] text-slate-500 dark:text-slate-400">
                  The only owner — promote someone else before removing or demoting this account.
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>

      {invitations.length > 0 ? (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 text-[11px] dark:divide-slate-800/60 dark:border-slate-800">
          {invitations.map((inv) => (
            <li key={inv.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
              <span className="min-w-0 flex-1">{inv.email}</span>
              <Badge variant="outline" className="font-mono text-[10px]">
                {inv.role}
              </Badge>
              <Badge
                variant="outline"
                className={
                  "font-mono text-[10px] " +
                  (inv.status === "pending"
                    ? "text-sky-700 dark:text-sky-400"
                    : inv.status === "accepted"
                      ? "text-emerald-700 dark:text-emerald-400"
                      : "text-slate-500")
                }
              >
                {inv.status}
              </Badge>
              {inv.status === "pending" ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-[11px]"
                  onClick={() => void companyAction("revoke_invitation", { id: inv.id }).then(onChanged)}
                >
                  Revoke
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <InviteForm onSaved={onChanged} />
    </div>
  );
}
