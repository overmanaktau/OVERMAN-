"use client";

import AppShell from "@/components/AppShell";
import { useAuth } from "@/components/AuthGate";

function RequireWarehouseAccess({ children }: { children: React.ReactNode }) {
  const { role, isAdmin, permissions } = useAuth();

  if (role === null) return null; // AuthGate already showed a loading/error state
  const canAccess = isAdmin || permissions["warehouse.stock"].canView;
  if (!canAccess) {
    return (
      <div className="bg-surface border border-border rounded-card p-8 max-w-md">
        <p className="text-sm text-muted">У вас нет доступа к разделу «Склад».</p>
      </div>
    );
  }
  return <>{children}</>;
}

export default function WarehouseLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell>
      <RequireWarehouseAccess>{children}</RequireWarehouseAccess>
    </AppShell>
  );
}
