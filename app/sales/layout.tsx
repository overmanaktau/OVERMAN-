"use client";

import Sidebar from "@/components/Sidebar";
import AuthGate, { useAuth } from "@/components/AuthGate";
import { StoreSelectionProvider } from "@/components/StoreSelection";

function RequireSalesAccess({ children }: { children: React.ReactNode }) {
  const { role, isAdmin, permissions } = useAuth();

  if (role === null) return null; // AuthGate already showed a loading/error state
  const canAccess = isAdmin || permissions["marketing.statistics"].canView;
  if (!canAccess) {
    return (
      <div className="bg-surface border border-border rounded-card p-8 max-w-md">
        <p className="text-sm text-muted">У вас нет доступа к разделу «Продажа».</p>
      </div>
    );
  }
  return <>{children}</>;
}

export default function SalesLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGate>
      <StoreSelectionProvider>
        <div className="min-h-screen flex bg-paper text-ink">
          <Sidebar />
          <div className="flex-1 box-border px-12 py-10 pb-14 flex flex-col gap-6 min-w-0">
            <RequireSalesAccess>{children}</RequireSalesAccess>
          </div>
        </div>
      </StoreSelectionProvider>
    </AuthGate>
  );
}
