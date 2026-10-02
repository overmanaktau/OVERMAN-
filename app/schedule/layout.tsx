"use client";

import AppShell from "@/components/AppShell";
import { useAuth } from "@/components/AuthGate";

function RequireScheduleAccess({ children }: { children: React.ReactNode }) {
  const { role, isAdmin, permissions } = useAuth();

  if (role === null) return null; // AuthGate already showed a loading/error state
  const canAccess = isAdmin || permissions["schedule"].canView || permissions["schedule"].canEdit;
  if (!canAccess) {
    return (
      <div className="bg-surface border border-border rounded-card p-8 max-w-md">
        <p className="text-sm text-muted">У вас нет доступа к разделу «График смен».</p>
      </div>
    );
  }
  return <>{children}</>;
}

export default function ScheduleLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell>
      <RequireScheduleAccess>{children}</RequireScheduleAccess>
    </AppShell>
  );
}
