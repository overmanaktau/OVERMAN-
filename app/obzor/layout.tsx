"use client";

import AppShell from "@/components/AppShell";
import { useAuth } from "@/components/AuthGate";

function RequireOverviewAccess({ children }: { children: React.ReactNode }) {
  const { role, isAdmin, permissions } = useAuth();

  if (role === null) return null; // AuthGate already showed a loading/error state
  const canAccess = isAdmin || permissions["marketing.statistics"].canView;
  if (!canAccess) {
    return (
      <div className="bg-surface border border-border rounded-card p-8 max-w-md">
        <p className="text-sm text-muted">У вас нет доступа к разделу «Обзор».</p>
      </div>
    );
  }
  return <>{children}</>;
}

export default function ObzorLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell>
      <RequireOverviewAccess>{children}</RequireOverviewAccess>
    </AppShell>
  );
}
