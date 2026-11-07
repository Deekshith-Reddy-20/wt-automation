import type { ReactNode } from "react";
import { ResortTabs } from "./resort-tabs";
import { ResortSetupBanner } from "./setup-banner";

export const metadata = { title: "V-Farms Resort" };

export default function ResortLayout({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">V-Farms Resort</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Whole-estate stays and private events — enquiries, bookings, calendar and the WhatsApp assistant.
        </p>
      </div>
      <ResortSetupBanner />
      <ResortTabs />
      <div>{children}</div>
    </div>
  );
}
