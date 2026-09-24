"use client";

import { useState } from "react";

// Excel (RU locale, which is what this business runs on) expects ";" as the
// list separator for a double-clicked CSV — a comma-separated file opens
// with everything crammed into a single column instead of proper cells.
// The UTF-8 BOM is what makes Excel read Cyrillic correctly instead of
// mangling it.
function downloadExcel(filename: string, headers: string[], rows: (string | number)[][]) {
  const escape = (v: string | number) => {
    const s = String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers, ...rows].map((r) => r.map(escape).join(";")).join("\r\n");
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

  const filtered = query.trim()
    ? rows.filter((r) => getSearchText(r).toLowerCase().includes(query.trim().toLowerCase()))
    : rows;

  const iconBtn = "text-muted hover:text-ink hover:bg-paper";

  function handleDownload() {
    downloadExcel(csvFilename, csvHeaders, filtered.map(toCsvRow));
  }

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
          className="text-[12.5px] rounded-md px-2 py-1 border border-border bg-surface text-ink placeholder:text-mutedLight w-[140px] mr-1 focus:outline-none"
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
      <button type="button" title="Скачать в Excel" onClick={handleDownload} className={`w-7 h-7 rounded-md flex items-center justify-center ${iconBtn}`}>
        <IconDownload />
      </button>
      <button
        type="button"
        title="Поиск"
        onClick={() => setSearching((v) => !v)}
        className={`w-7 h-7 rounded-md flex items-center justify-center ${iconBtn} ${searching ? "bg-paper" : ""}`}
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
    </div>
  );

  return (
    <>
      <div className="bg-surface border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5">
        <div className="flex items-center justify-between gap-3">
          <div className="text-[15px] font-bold text-ink">{title}</div>
          {toolbar}
        </div>
        {!collapsed && <div className="overflow-x-auto">{children(filtered)}</div>}
      </div>

      {expanded && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-6" onClick={() => setExpanded(false)}>
          <div
            className="w-full max-w-[1200px] max-h-[85vh] overflow-auto rounded-card border border-border bg-surface px-6 py-[22px] flex flex-col gap-3.5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="text-[15px] font-bold text-ink">{title}</div>
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className={`w-7 h-7 rounded-md flex items-center justify-center ${iconBtn}`}
              >
                <IconClose />
              </button>
            </div>
            <div className="overflow-x-auto">{children(filtered)}</div>
          </div>
        </div>
      )}
    </>
  );
}
