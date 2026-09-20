"use client";

import { useEffect, useRef, useState } from "react";

type Theme = "system" | "light" | "dark";

function useResolvedDark(theme: Theme): boolean {
  const [systemDark, setSystemDark] = useState(false);
  useEffect(() => {
    if (theme !== "system" || typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    setSystemDark(mq.matches);
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);
  return theme === "dark" || (theme === "system" && systemDark);
}

function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]) {
  const escape = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers, ...rows].map((r) => r.map(escape).join(",")).join("\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function IconEye() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
function IconEyeOff() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 7 11 7a18.5 18.5 0 0 1-2.16 3.19M6.61 6.61C3.87 8.36 2 11 1 12c0 0 4 7 11 7a10.9 10.9 0 0 0 5.39-1.61M14.12 14.12a3 3 0 1 1-4.24-4.24" />
      <path d="M1 1l22 22" />
    </svg>
  );
}
function IconDownload() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 10l5 5 5-5" />
      <path d="M12 15V3" />
    </svg>
  );
}
function IconSearch() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <path d="M21 21l-4.35-4.35" />
    </svg>
  );
}
function IconExpand() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3" />
    </svg>
  );
}
function IconClose() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}
function IconMore() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="5" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="12" cy="19" r="1.6" />
    </svg>
  );
}
function IconSystem() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" stroke="none" />
    </svg>
  );
}
function IconSun() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}
function IconMoon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
    </svg>
  );
}

export function DataTableCard<T>({
  title,
  rows,
  getSearchText,
  csvHeaders,
  toCsvRow,
  csvFilename,
  children,
}: {
  title: string;
  rows: T[];
  getSearchText: (row: T) => string;
  csvHeaders: string[];
  toCsvRow: (row: T) => (string | number)[];
  csvFilename: string;
  children: (rows: T[]) => React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>("system");
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [menuOpen]);

  const dark = useResolvedDark(theme);
  const filtered = query.trim()
    ? rows.filter((r) => getSearchText(r).toLowerCase().includes(query.trim().toLowerCase()))
    : rows;

  const cardBg = dark ? "bg-[#17140F] border-[#3A362E]" : "bg-white border-border";
  const titleColor = dark ? "text-sidebarText" : "text-ink";
  const iconBtn = dark
    ? "text-sidebarMuted hover:text-sidebarText hover:bg-[#232019]"
    : "text-muted hover:text-ink hover:bg-[#F1EEE6]";
  const inputCls = dark
    ? "bg-[#232019] border-[#3A362E] text-sidebarText placeholder:text-sidebarMuted"
    : "bg-white border-border text-ink placeholder:text-mutedLight";

  function handleDownload() {
    downloadCsv(csvFilename, csvHeaders, filtered.map(toCsvRow));
  }

  const themeMenu = menuOpen && (
    <div
      className={`absolute right-0 top-full mt-1 z-30 rounded-lg border p-1 flex items-center gap-0.5 shadow-lg ${
        dark ? "bg-[#232019] border-[#3A362E]" : "bg-white border-border"
      }`}
    >
      {(["system", "light", "dark"] as Theme[]).map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => {
            setTheme(t);
            setMenuOpen(false);
          }}
          title={t === "system" ? "Системная" : t === "light" ? "Светлая" : "Тёмная"}
          className={`w-8 h-8 rounded-md flex items-center justify-center ${
            theme === t
              ? "bg-accent text-paper"
              : dark
              ? "text-sidebarMuted hover:text-sidebarText"
              : "text-muted hover:text-ink"
          }`}
        >
          {t === "system" ? <IconSystem /> : t === "light" ? <IconSun /> : <IconMoon />}
        </button>
      ))}
    </div>
  );

  const toolbar = (
    <div className="flex items-center gap-1">
      {searching && (
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onBlur={() => {
            if (!query) setSearching(false);
          }}
          placeholder="Поиск…"
          className={`text-[12.5px] rounded-md px-2 py-1 border w-[140px] mr-1 focus:outline-none ${inputCls}`}
        />
      )}
      <button
        type="button"
        title={collapsed ? "Показать" : "Скрыть"}
        onClick={() => setCollapsed((v) => !v)}
        className={`w-7 h-7 rounded-md flex items-center justify-center ${iconBtn}`}
      >
        {collapsed ? <IconEyeOff /> : <IconEye />}
      </button>
      <button type="button" title="Скачать CSV" onClick={handleDownload} className={`w-7 h-7 rounded-md flex items-center justify-center ${iconBtn}`}>
        <IconDownload />
      </button>
      <button
        type="button"
        title="Поиск"
        onClick={() => setSearching((v) => !v)}
        className={`w-7 h-7 rounded-md flex items-center justify-center ${iconBtn} ${searching ? (dark ? "bg-[#232019]" : "bg-[#F1EEE6]") : ""}`}
      >
        <IconSearch />
      </button>
      <button
        type="button"
        title="На весь экран"
        onClick={() => setExpanded(true)}
        className={`w-7 h-7 rounded-md flex items-center justify-center ${iconBtn}`}
      >
        <IconExpand />
      </button>
      <div className="relative" ref={menuRef}>
        <button
          type="button"
          title="Ещё"
          onClick={() => setMenuOpen((v) => !v)}
          className={`w-7 h-7 rounded-md flex items-center justify-center ${iconBtn}`}
        >
          <IconMore />
        </button>
        {themeMenu}
      </div>
    </div>
  );

  return (
    <>
      <div className={`border rounded-card px-6 py-[22px] flex flex-col gap-3.5 ${cardBg}`}>
        <div className="flex items-center justify-between gap-3">
          <div className={`text-[15px] font-bold ${titleColor}`}>{title}</div>
          {toolbar}
        </div>
        {!collapsed && children(filtered)}
      </div>

      {expanded && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-6" onClick={() => setExpanded(false)}>
          <div
            className={`w-full max-w-[1200px] max-h-[85vh] overflow-auto rounded-card border px-6 py-[22px] flex flex-col gap-3.5 ${cardBg}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3">
              <div className={`text-[15px] font-bold ${titleColor}`}>{title}</div>
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className={`w-7 h-7 rounded-md flex items-center justify-center ${iconBtn}`}
              >
                <IconClose />
              </button>
            </div>
            {children(filtered)}
          </div>
        </div>
      )}
    </>
  );
}
