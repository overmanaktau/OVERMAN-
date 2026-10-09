"use client";

import AuthGate from "@/components/AuthGate";

// Экран кассы — отдельная страница без бокового меню портала: ничего лишнего, только клиенты и сертификаты.
export default function KassaLayout({ children }: { children: React.ReactNode }) {
  return <AuthGate>{children}</AuthGate>;
}
