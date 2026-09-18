"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/components/AuthGate";
import type { SectionKey } from "@/lib/permissions";

const TOP_LEVEL: { label: string; soon: boolean }[] = [
  { label: "Обзор", soon: true },
  { label: "Продажа", soon: true },
  { label: "Склад", soon: true },
];

const MARKETING_SUBMENU: { label: string; href: string; section: SectionKey }[] = [
  { label: "Статистика", href: "/marketing/statistics", section: "marketing.statistics" },
  { label: "Публикации", href: "/marketing/publications", section: "marketing.publications" },
  { label: "Инстаграм таргет", href: "/marketing/instagram-target", section: "marketing.instagram_target" },
  { label: "Внесение данных", href: "/marketing/data-entry", section: "marketing.data_entry" },
];

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { email, isAdmin, permissions } = useAuth();
  const visibleMarketing = MARKETING_SUBMENU.filter(
    (item) => isAdmin || permissions[item.section]?.canView
  );

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  return (
    <div className="w-[248px] flex-none bg-sidebar text-sidebarText box-border p-8 px-5 flex flex-col gap-6">
      <div className="flex flex-col gap-0.5 px-2">
        <div className="font-serif text-2xl font-semibold tracking-wide">OVERMAN</div>
        <div className="text-xs text-sidebarMuted tracking-wider uppercase">Портал бизнеса</div>
      </div>

      <nav className="flex flex-col gap-1">
        {TOP_LEVEL.map((item) => (
          <div
            key={item.label}
            className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg text-[#6B6455] text-sm font-medium"
          >
            <span>{item.label}</span>
            {item.soon && (
              <span className="text-[10px] tracking-wide uppercase text-sidebarMuted border border-[#3A362E] rounded-full px-2 py-0.5">
                скоро
              </span>
            )}
          </div>
        ))}

        {visibleMarketing.length > 0 && (
          <div className="flex flex-col gap-0.5 mt-1">
            <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sidebarText text-sm font-semibold">
              Маркетинг
            </div>
            <div className="flex flex-col gap-0.5 pl-[30px] ml-[21px] border-l border-[#2C2820]">
              {visibleMarketing.map((item) => {
                const active = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`px-3 py-2 rounded-md text-[13px] ${
                      active
                        ? "bg-accent text-paper font-semibold"
                        : "text-[#A39D8E] font-medium hover:text-sidebarText"
                    }`}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg text-[#6B6455] text-sm font-medium mt-1">
          <span>Финансы</span>
          <span className="text-[10px] tracking-wide uppercase text-sidebarMuted border border-[#3A362E] rounded-full px-2 py-0.5">
            скоро
          </span>
        </div>

        {isAdmin && (
          <Link
            href="/settings/employees"
            className={`px-3 py-2.5 rounded-lg text-sm font-medium mt-1 ${
              pathname.startsWith("/settings")
                ? "bg-accent text-paper font-semibold"
                : "text-[#6B6455] hover:text-sidebarText"
            }`}
          >
            Настройки
          </Link>
        )}
      </nav>

      <div className="mt-auto flex flex-col gap-2.5">
        <div className="h-px bg-[#2C2820]" />
        <div className="text-[11px] text-sidebarMuted tracking-wider uppercase px-2">
          Точки продаж
        </div>
        <div className="flex flex-col gap-0.5 px-2">
          <label className="flex items-center gap-2 text-[13px] text-[#C9C3B6] py-1">
            <input type="checkbox" defaultChecked className="accent-accent" /> Точка 1
          </label>
          <label className="flex items-center gap-2 text-[13px] text-[#C9C3B6] py-1">
            <input type="checkbox" defaultChecked className="accent-accent" /> Точка 2
          </label>
        </div>
        <div className="h-px bg-[#2C2820] mt-1" />
        <div className="px-2 flex flex-col gap-1.5">
          {email && <div className="text-[11px] text-sidebarMuted truncate">{email}</div>}
          <button
            type="button"
            onClick={handleLogout}
            className="text-[13px] text-[#C9C3B6] text-left hover:text-sidebarText"
          >
            Выйти
          </button>
        </div>
      </div>
    </div>
  );
}
