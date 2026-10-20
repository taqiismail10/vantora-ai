"use client";

/**
 * The signed-in person's control, distinct from the company they are in:
 * CompanySwitcher always names the workspace (Building2), this names the
 * user (initials chip + their name).
 *
 * Deliberately a compact identity-and-sign-out menu, not a settings hub:
 * the product has no profile page and no account-settings destination, so
 * there is nothing behind a "Profile" item to open. Identity is display
 * only; every route re-checks the session itself. Dismissal and keyboard
 * behaviour mirror CompanySwitcher so both header popups behave alike:
 * Escape closes and refocuses the trigger, a click outside closes, and the
 * arrow keys cycle the items.
 */

import { useEffect, useRef, useState } from "react";
import { ChevronDown, LoaderCircle, LogOut } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { authClient } from "@/lib/auth-client";
import type { HumanRole } from "@/lib/server/identity";
import { cn } from "@/lib/utils";

const FOCUS_RING =
  "outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:border-sky-500";

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0]![0]! + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function AccountMenu({
  name,
  email,
  role,
  sessionExpiresAt,
}: {
  name: string;
  email: string;
  role: HumanRole;
  sessionExpiresAt: string;
}) {
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = "account-menu";

  const signOut = async () => {
    setSigningOut(true);
    await authClient.signOut();
    // Full navigation so nothing of this session survives in the client cache.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- deliberate full reload on an identity change
    window.location.assign("/login?reason=signed_out");
  };

  // Dismiss with Escape (focus returns to the trigger) or by clicking outside
  // — the same popup contract the company switcher uses.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && event.target instanceof Node && rootRef.current.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  const onMenuKeyDown = (event: React.KeyboardEvent) => {
    const items = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      items[(index + 1 + items.length) % items.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      items[(index - 1 + items.length) % items.length]?.focus();
    } else if (event.key === "Home" && items[0]) {
      event.preventDefault();
      items[0].focus();
    } else if (event.key === "End" && items[items.length - 1]) {
      event.preventDefault();
      items[items.length - 1].focus();
    } else if (event.key === "Escape") {
      setOpen(false);
      triggerRef.current?.focus();
    }
  };

  const expires = new Date(sessionExpiresAt);

  return (
    <div className="relative" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={open ? menuId : undefined}
        title={email}
        className={cn(
          "inline-flex max-w-[12rem] items-center gap-1.5 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-100 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-800",
          FOCUS_RING,
        )}
      >
        <span
          aria-hidden
          className="flex size-5 shrink-0 items-center justify-center rounded-full bg-slate-200 text-[10px] font-semibold text-slate-900 dark:bg-slate-700 dark:text-slate-100"
        >
          {initials(name)}
        </span>
        <span className="truncate">{name}</span>
        <ChevronDown className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")} aria-hidden />
      </button>

      {open ? (
        <div
          role="menu"
          id={menuId}
          aria-label="Account"
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 top-full z-30 mt-1 w-64 overflow-hidden rounded-md border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-800 dark:bg-slate-950"
        >
          {/* Identity header: who the session belongs to. The session clock
              was previously visible only on wide screens; inside the menu it
              is reachable everywhere. */}
          <div role="none" className="border-b border-slate-200 px-3 pb-2.5 pt-2 dark:border-slate-800">
            <p className="truncate text-[11px] font-semibold text-slate-900 dark:text-slate-50">{name}</p>
            <p className="truncate text-[10px] text-slate-500 dark:text-slate-400">{email}</p>
            <div className="mt-1.5 flex items-center gap-1.5">
              <Badge variant="outline" className="font-mono text-[10px]">
                {role}
              </Badge>
              <span className="text-[10px] text-slate-500 dark:text-slate-400">
                session until{" "}
                {expires.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
          </div>
          <div role="none" className="py-0.5">
            <button
              role="menuitem"
              type="button"
              onClick={signOut}
              disabled={signingOut}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-slate-800 hover:bg-slate-100 disabled:opacity-50 dark:text-slate-200 dark:hover:bg-slate-800",
                FOCUS_RING,
              )}
            >
              {signingOut ? (
                <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <LogOut className="size-3.5" aria-hidden />
              )}
              Sign out
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
