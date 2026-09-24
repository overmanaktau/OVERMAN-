"use client";

import AppShell from "@/components/AppShell";
import { useAuth } from "@/components/AuthGate";

function RequireSettingsAccess({ children }: { children: React.ReactNode }) {
  const { role, isAdmin, permissions } = useAuth();

  if (role === null) return null; // AuthGate already showed a loading/error state
  if (!isAdmin && !permissions["settings.employees"].canView && !permissions["settings.passwords"].canView) {
    return (
      <div className="bg-surface border border-border rounded-card p-8 max-w-md">
        <p className="text-sm text-muted">У вас нет доступа к разделу «Настройки».</p>
      </div>
    );
  }
  return <>{children}</>;
}

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell>
      <RequireSettingsAccess>{children}</RequireSettingsAccess>
    </AppShell>
  );
}
