"use client";

import { useAuth } from "@/components/AuthGate";

export default function PublicationsPage() {
  const { isAdmin, permissions } = useAuth();
  if (!isAdmin && !permissions["marketing.publications"].canView) {
    return (
      <div className="bg-white border border-border rounded-card p-8 max-w-md">
        <p className="text-sm text-muted">У вас нет доступа к разделу «Публикации».</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="text-xs text-mutedLight">Маркетинг</div>
      <h1 className="font-serif text-[28px] font-semibold m-0">Публикации</h1>
      <p className="text-sm text-muted mt-2">Экран ещё не спроектирован.</p>
    </div>
  );
}
