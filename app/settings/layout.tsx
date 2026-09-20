"use client";

import Sidebar from "@/components/Sidebar";
import AuthGate, { useAuth } from "@/components/AuthGate";
import { StoreSelectionProvider } from "@/components/StoreSelection";

function AdminOnly({ children }: { children: React.ReactNode }) {
  const { role } = useAuth();

  if (role === null) return null; // AuthGate already showed a loading/error state
  if (role !== "admin") {
    return (
      <div className="bg-white border border-border rounded-card p-8 max-w-md">
        <p className="text-sm text-muted">Раздел «Настройки» доступен только администратору.</p>
      </div>
    );
  }
  return <>{children}</>;
}

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGate>
      <StoreSelectionProvider>
        <div className="min-h-screen flex bg-paper text-ink">
          <Sidebar />
          <div className="flex-1 box-border px-12 py-10 pb-14 flex flex-col gap-6 min-w-0">
            <AdminOnly>{children}</AdminOnly>
          </div>
        </div>
      </StoreSelectionProvider>
    </AuthGate>
  );
}
