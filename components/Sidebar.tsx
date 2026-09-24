"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/components/AuthGate";
import { useStoreSelection } from "@/components/StoreSelection";
import { useUnsavedChanges } from "@/components/UnsavedChangesContext";
import { useSiteVersion } from "@/components/SiteVersion";
import AccountMenu from "@/components/AccountMenu";
import { supabase } from "@/lib/supabaseClient";
import type { SectionKey } from "@/lib/permissions";

const TOP_LEVEL: { label: string; soon: boolean }[] = [
  { label: "Обзор", soon: true },
  { label: "Склад", soon: true },
];

const MARKETING_SUBMENU: { label: string; href: string; section: SectionKey }[] = [
  { label: "Статистика", href: "/marketing/statistics", section: "marketing.statistics" },
  { label: "Публикации", href: "/marketing/publications", section: "marketing.publications" },
  { label: "Инстаграм таргет", href: "/marketing/instagram-target", section: "marketing.instagram_target" },
  { label: "Аналитика конкурентов", href: "/marketing/competitor-analytics", section: "marketing.competitor_analytics" },
  { label: "Внесение данных", href: "/marketing/data-entry", section: "marketing.data_entry" },
];

const SETTINGS_SUBMENU: { label: string; href: string; section: SectionKey }[] = [
  { label: "Сотрудники и доступы", href: "/settings/employees", section: "settings.employees" },
  { label: "Пароли", href: "/settings/passwords", section: "settings.passwords" },
  { label: "История", href: "/history", section: "history" },
];

function GuardedLink({
  href,
  className,
  onNavigate,
  children,
}: {
  href: string;
  className?: string;
  onNavigate?: () => void;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { isDirty, requestNavigation } = useUnsavedChanges();
  return (
    <Link
      href={href}
      className={className}
      onClick={(e) => {
        if (isDirty) {
          e.preventDefault();
          requestNavigation(() => router.push(href));
          return;
        }
        onNavigate?.();
      }}
    >
      {children}
    </Link>
  );
}

function StorePicker() {
  const { cities, stores, accessibleStoreCodes } = useAuth();
  const { selected, setSelected, toggle, isAll, setAll } = useStoreSelection();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const visibleStores = stores.filter((s) => accessibleStoreCodes.includes(s.code));
  const visibleCities = cities.filter((c) => visibleStores.some((s) => s.city_id === c.id));

  const label = isAll
    ? "Все города"
    : selected.length === 0
    ? "Нет городов"
    : selected.length === 1
    ? stores.find((s) => s.code === selected[0])?.name ?? selected[0]
    : `${selected.length} города`;

  if (visibleStores.length === 0) return null;

  return (
    <div className="relative px-2" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-2 bg-[#232019] border border-[#3A362E] rounded-lg px-3 py-2.5 text-[13px] text-sidebarText"
      >
        <span className="truncate">{label}</span>
        <span className="text-sidebarMuted text-[10px]">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="absolute z-20 top-full left-2 right-2 mt-1 bg-[#232019] border border-[#3A362E] rounded-lg p-2 flex flex-col gap-1 shadow-lg max-h-[280px] overflow-y-auto">
          <label className="flex items-center gap-2 text-[13px] text-sidebarText py-1.5 px-1.5 rounded-md hover:bg-[#2C2820] cursor-pointer font-semibold">
            <input
              type="checkbox"
              checked={isAll}
              onChange={() => (isAll ? setSelected([]) : setAll())}
              className="accent-accent"
            />
            Все города
          </label>
          <div className="h-px bg-[#3A362E] my-1" />
          {visibleCities.map((city) => {
            const store = visibleStores.find((s) => s.city_id === city.id);
            if (!store) return null;
            return (
              <label
                key={city.id}
                className="flex items-center gap-2 text-[13px] text-[#C9C3B6] py-1.5 px-1.5 rounded-md hover:bg-[#2C2820] cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={selected.includes(store.code)}
                  onChange={() => toggle(store.code)}
                  className="accent-accent"
                />
                {city.name}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function Sidebar() {
  const pathname = usePathname();
  const { isAdmin, permissions } = useAuth();
  const visibleMarketing = MARKETING_SUBMENU.filter(
    (item) => isAdmin || permissions[item.section]?.canView
  );
  const visibleSettings = SETTINGS_SUBMENU.filter(
    (item) => isAdmin || permissions[item.section]?.canView
  );
  const canSeeRequests = isAdmin || permissions["requests"].canView || permissions["requests"].canEdit;
  const canSeeSales = isAdmin || permissions["marketing.statistics"].canView;
  const { mobileLayout } = useSiteVersion();

  // RLS on edit_requests already scopes this to "my own requests" or "every
  // pending request" depending on whether the viewer has requests.view/edit —
  // same rule the /requests page itself relies on — so this count is never
  // wider than what that person could already see by opening the page.
  const [pendingRequests, setPendingRequests] = useState(0);
  useEffect(() => {
    if (!canSeeRequests) return;
    let cancelled = false;
    async function loadCount() {
      const { count } = await supabase
        .from("edit_requests")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending");
      if (!cancelled) setPendingRequests(count ?? 0);
    }
    loadCount();
    const interval = setInterval(loadCount, 60000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [canSeeRequests]);

  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => ({
    marketing: MARKETING_SUBMENU.some((item) => pathname === item.href),
    settings: SETTINGS_SUBMENU.some((item) => pathname === item.href),
  }));
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    if (!mobileLayout) setMobileOpen(false);
  }, [mobileLayout]);

  function toggleGroup(key: string) {
    setOpenGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function closeMobile() {
    setMobileOpen(false);
  }

  return (
    <>
      {/* Mobile top bar: when mobileLayout is on, the sidebar below is
          off-canvas, so this is the only nav chrome visible until the
          hamburger opens it. */}
      {mobileLayout && (
        <div className="fixed top-0 left-0 right-0 h-14 bg-sidebar border-b border-[#3A362E] z-40 flex items-center px-4 gap-3">
          <button
            type="button"
            aria-label="Открыть меню"
            onClick={() => setMobileOpen(true)}
            className="w-9 h-9 -ml-1 rounded-md flex items-center justify-center text-sidebarText"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M3 6h18M3 12h18M3 18h18" />
            </svg>
          </button>
          <div className="font-serif text-lg font-semibold tracking-wide text-sidebarText">OVERMAN</div>
        </div>
      )}

      {mobileLayout && mobileOpen && (
        <div className="fixed inset-0 bg-black/50 z-40" onClick={closeMobile} />
      )}

      {/* Rendered outside the (transformed) drawer div on purpose: a
          `transform` on an ancestor makes it the containing block for any
          `fixed` descendant, which would otherwise pin this to the drawer's
          own box instead of the viewport's top-right corner. */}
      <div className="fixed top-4 right-4 z-[100] flex items-center gap-2">
        <AccountMenu />
      </div>

      <div
        className={`w-[248px] flex-none bg-sidebar text-sidebarText box-border p-8 px-5 flex flex-col gap-6 overflow-y-auto ${
          mobileLayout
            ? `fixed inset-y-0 left-0 z-50 transition-transform duration-200 ${
                mobileOpen ? "translate-x-0" : "-translate-x-full"
              }`
            : "static translate-x-0"
        }`}
      >
      <div className="flex flex-col gap-0.5 px-2">
        <div className="font-serif text-2xl font-semibold tracking-wide">OVERMAN</div>
        <div className="text-xs text-sidebarMuted tracking-wider uppercase">Портал бизнеса</div>
      </div>

      <StorePicker />

      <nav className="flex flex-col gap-1">
        {TOP_LEVEL.map((item, i) => (
          <div key={item.label}>
            <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg text-[#6B6455] text-sm font-medium">
              <span>{item.label}</span>
              {item.soon && (
                <span className="text-[10px] tracking-wide uppercase text-sidebarMuted border border-[#3A362E] rounded-full px-2 py-0.5">
                  скоро
                </span>
              )}
            </div>
            {i === 0 && canSeeSales && (
              <GuardedLink
                href="/sales"
                onNavigate={closeMobile}
                className={`block px-3 py-2.5 rounded-lg text-sm font-semibold ${
                  pathname === "/sales" ? "bg-accent text-paper" : "text-sidebarText hover:text-sidebarText"
                }`}
              >
                Продажа
              </GuardedLink>
            )}
          </div>
        ))}

        {visibleMarketing.length > 0 && (
          <div className="flex flex-col gap-0.5 mt-1">
            <button
              type="button"
              onClick={() => toggleGroup("marketing")}
              className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg text-sidebarText text-sm font-semibold"
            >
              <span>Маркетинг</span>
              <span className="text-sidebarMuted text-[10px]">{openGroups.marketing ? "▲" : "▼"}</span>
            </button>
            {openGroups.marketing && (
              <div className="flex flex-col gap-0.5 pl-[30px] ml-[21px] border-l border-[#2C2820]">
                {visibleMarketing.map((item) => {
                  const active = pathname === item.href;
                  return (
                    <GuardedLink
                      key={item.href}
                      href={item.href}
                      onNavigate={closeMobile}
                      className={`px-3 py-2 rounded-md text-[13px] ${
                        active
                          ? "bg-accent text-paper font-semibold"
                          : "text-[#A39D8E] font-medium hover:text-sidebarText"
                      }`}
                    >
                      {item.label}
                    </GuardedLink>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {canSeeRequests && (
          <GuardedLink
            href="/requests"
            onNavigate={closeMobile}
            className={`flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg text-sm mt-1 ${
              pathname === "/requests"
                ? "bg-accent text-paper font-semibold"
                : "text-sidebarText font-semibold hover:text-sidebarText"
            }`}
          >
            <span>Запросы</span>
            {pendingRequests > 0 && (
              <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] rounded-full bg-[#A34B36] text-white text-[10px] font-bold px-1">
                {pendingRequests}
              </span>
            )}
          </GuardedLink>
        )}

        <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg text-[#6B6455] text-sm font-medium mt-1">
          <span>Финансы</span>
          <span className="text-[10px] tracking-wide uppercase text-sidebarMuted border border-[#3A362E] rounded-full px-2 py-0.5">
            скоро
          </span>
        </div>

        {visibleSettings.length > 0 && (
          <div className="flex flex-col gap-0.5 mt-1">
            <button
              type="button"
              onClick={() => toggleGroup("settings")}
              className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg text-sidebarText text-sm font-semibold"
            >
              <span>Настройки</span>
              <span className="text-sidebarMuted text-[10px]">{openGroups.settings ? "▲" : "▼"}</span>
            </button>
            {openGroups.settings && (
              <div className="flex flex-col gap-0.5 pl-[30px] ml-[21px] border-l border-[#2C2820]">
                {visibleSettings.map((item) => {
                  const active = pathname === item.href;
                  return (
                    <GuardedLink
                      key={item.href}
                      href={item.href}
                      onNavigate={closeMobile}
                      className={`px-3 py-2 rounded-md text-[13px] ${
                        active
                          ? "bg-accent text-paper font-semibold"
                          : "text-[#A39D8E] font-medium hover:text-sidebarText"
                      }`}
                    >
                      {item.label}
                    </GuardedLink>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </nav>
      </div>
    </>
  );
}
