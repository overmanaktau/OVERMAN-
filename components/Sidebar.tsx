"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/components/AuthGate";
import { useStoreSelection } from "@/components/StoreSelection";
import { useUnsavedChanges } from "@/components/UnsavedChangesContext";
import AccountMenu from "@/components/AccountMenu";
import GlobalSaveButton from "@/components/GlobalSaveButton";
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

const SETTINGS_SUBMENU: { label: string; href: string; section: SectionKey }[] = [
  { label: "Сотрудники и доступы", href: "/settings/employees", section: "settings.employees" },
];

function GuardedLink({ href, className, children }: { href: string; className?: string; children: React.ReactNode }) {
  const router = useRouter();
  const { isDirty, requestNavigation } = useUnsavedChanges();
  return (
    <Link
      href={href}
      className={className}
      onClick={(e) => {
        if (!isDirty) return;
        e.preventDefault();
        requestNavigation(() => router.push(href));
      }}
    >
      {children}
    </Link>
  );
}

function StorePicker() {
  const { cities, stores, accessibleStoreCodes } = useAuth();
  const { selected, setSelected, toggle, toggleMany, isAll, setAll } = useStoreSelection();
  const [open, setOpen] = useState(false);
  const [openCities, setOpenCities] = useState<Set<number>>(() => new Set(cities.map((c) => c.id)));
  const containerRef = useRef<HTMLDivElement>(null);

  const visibleStores = stores.filter((s) => accessibleStoreCodes.includes(s.code));
  const visibleCities = cities.filter((c) => visibleStores.some((s) => s.city_id === c.id));

  const label = isAll
    ? "Все точки"
    : selected.length === 0
    ? "Нет точек"
    : selected.length === 1
    ? stores.find((s) => s.code === selected[0])?.name ?? selected[0]
    : `${selected.length} точки`;

  function toggleCityOpen(cityId: number) {
    setOpenCities((prev) => {
      const next = new Set(prev);
      if (next.has(cityId)) next.delete(cityId);
      else next.add(cityId);
      return next;
    });
  }

  function toggleWholeCity(cityId: number) {
    const cityStoreCodes = visibleStores.filter((s) => s.city_id === cityId).map((s) => s.code);
    const allSelected = cityStoreCodes.every((c) => selected.includes(c));
    toggleMany(cityStoreCodes, !allSelected);
  }

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
            Все точки
          </label>
          <div className="h-px bg-[#3A362E] my-1" />
          {visibleCities.map((city) => {
            const cityStores = visibleStores.filter((s) => s.city_id === city.id);
            const cityAllSelected = cityStores.every((s) => selected.includes(s.code));
            const cityOpen = openCities.has(city.id);
            return (
              <div key={city.id} className="flex flex-col">
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => toggleCityOpen(city.id)}
                    className="text-sidebarMuted text-[10px] w-4 flex-none"
                  >
                    {cityOpen ? "▾" : "▸"}
                  </button>
                  <label className="flex-1 flex items-center gap-2 text-[13px] text-[#C9C3B6] py-1.5 px-1.5 rounded-md hover:bg-[#2C2820] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={cityAllSelected}
                      onChange={() => toggleWholeCity(city.id)}
                      className="accent-accent"
                    />
                    {city.name}
                  </label>
                </div>
                {cityOpen && (
                  <div className="flex flex-col pl-[26px]">
                    {cityStores.map((s) => (
                      <label
                        key={s.code}
                        className="flex items-center gap-2 text-[12.5px] text-[#A39D8E] py-1 px-1.5 rounded-md hover:bg-[#2C2820] cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={selected.includes(s.code)}
                          onChange={() => toggle(s.code)}
                          className="accent-accent"
                        />
                        {s.name}
                      </label>
                    ))}
                  </div>
                )}
              </div>
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

  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => ({
    marketing: MARKETING_SUBMENU.some((item) => pathname === item.href),
    settings: SETTINGS_SUBMENU.some((item) => pathname === item.href),
  }));

  function toggleGroup(key: string) {
    setOpenGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  return (
    <div className="w-[248px] flex-none bg-sidebar text-sidebarText box-border p-8 px-5 flex flex-col gap-6">
      <div className="fixed top-4 right-4 z-[100] flex items-center gap-2">
        <GlobalSaveButton />
        <AccountMenu />
      </div>
      <div className="flex flex-col gap-0.5 px-2">
        <div className="font-serif text-2xl font-semibold tracking-wide">OVERMAN</div>
        <div className="text-xs text-sidebarMuted tracking-wider uppercase">Портал бизнеса</div>
      </div>

      <StorePicker />

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
            className={`px-3 py-2.5 rounded-lg text-sm mt-1 ${
              pathname === "/requests"
                ? "bg-accent text-paper font-semibold"
                : "text-sidebarText font-semibold hover:text-sidebarText"
            }`}
          >
            Запросы
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
  );
}
