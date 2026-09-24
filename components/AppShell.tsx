"use client";

import Sidebar from "@/components/Sidebar";
import AuthGate from "@/components/AuthGate";
import { StoreSelectionProvider } from "@/components/StoreSelection";
import { SiteVersionProvider, useSiteVersion } from "@/components/SiteVersion";

// Shared by every route-group layout (marketing/settings/sales/requests/
// history) — was duplicated 5x verbatim, which made the mobile-nav rework
// below a 5-file edit instead of a 1-file one.
export default function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthGate>
      <StoreSelectionProvider>
        <SiteVersionProvider>
          <ShellBody>{children}</ShellBody>
        </SiteVersionProvider>
      </StoreSelectionProvider>
    </AuthGate>
  );
}

function ShellBody({ children }: { children: React.ReactNode }) {
  const { mobileLayout } = useSiteVersion();
  return (
    <div className={`min-h-screen flex bg-paper text-ink ${mobileLayout ? "flex-col" : "flex-row"}`}>
      <Sidebar />
      <div
        className={`flex-1 box-border flex flex-col gap-6 min-w-0 pb-14 ${
          mobileLayout ? "px-4 sm:px-8 pt-20" : "px-12 pt-10"
        }`}
      >
        {children}
      </div>
    </div>
  );
}
