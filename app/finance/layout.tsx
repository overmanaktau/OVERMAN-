"use client";

import AppShell from "@/components/AppShell";
import { useAuth } from "@/components/AuthGate";

function RequireFinanceAccess({ children }: { children: React.ReactNode }) {
  const { role, isAdmin, permissions } = useAuth();
  if (role === null) return null; // AuthGate already showed a loading/error state
  const any = ["finance.overview", "finance.dds", "finance.opiu", "finance.debts", "finance.planned", "finance.settings"] as const;
  if (!isAdmin && !any.some((k) => permissions[k].canView)) {
    return (
      <div className="bg-surface border border-border rounded-card p-8 max-w-md">
        <p className="text-sm text-muted">У вас нет доступа к разделу «Финансы».</p>
      </div>
    );
  }
  return <>{children}</>;
}

export default function FinanceLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell>
      <RequireFinanceAccess>{children}</RequireFinanceAccess>
    </AppShell>
  );
}
