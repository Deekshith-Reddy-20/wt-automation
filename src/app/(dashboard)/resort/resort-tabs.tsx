"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/resort", label: "Overview" },
  { href: "/resort/bookings", label: "Bookings" },
  { href: "/resort/leads", label: "Leads" },
  { href: "/resort/calendar", label: "Calendar" },
  { href: "/resort/inbox", label: "Bot & handoff" },
  { href: "/resort/pricing", label: "Pricing" },
  { href: "/resort/property", label: "Property" },
  { href: "/resort/settings", label: "Settings" },
];

export function ResortTabs() {
  const pathname = usePathname();
  return (
    <nav aria-label="Resort sections" className="-mx-1 flex gap-1 overflow-x-auto border-b border-border pb-px">
      {TABS.map((t) => {
        const active = t.href === "/resort" ? pathname === "/resort" : pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "whitespace-nowrap rounded-t-md px-3 py-2 text-sm transition-colors",
              active
                ? "border-b-2 border-primary font-semibold text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
