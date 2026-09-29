"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type Notification = { id: number; type: string; message: string; created_at: string };

function formatWhen(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function IconBell() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

export default function NotificationsBell() {
  const [userId, setUserId] = useState<string | null>(null);
  const userIdRef = useRef<string | null>(null);
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [lastReadAt, setLastReadAt] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  async function load() {
    const uid = userIdRef.current;
    const [{ data: notifRows }, { data: readRow }] = await Promise.all([
      supabase.from("notifications").select("id, type, message, created_at").order("created_at", { ascending: false }).limit(50),
      uid ? supabase.from("user_notification_reads").select("last_read_at").eq("user_id", uid).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    setNotifications(notifRows ?? []);
    setLastReadAt(readRow?.last_read_at ?? null);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const uid = session?.user.id ?? null;
      if (cancelled) return;
      userIdRef.current = uid;
      setUserId(uid);
      load();
    })();
    // Nothing pushes these live — a 60s poll matches the same cadence the
    // sidebar already uses for the "Запросы" badge count.
    const interval = setInterval(load, 60000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const unreadCount = lastReadAt ? notifications.filter((n) => n.created_at > lastReadAt).length : notifications.length;

  async function handleOpen() {
    setOpen((v) => !v);
    if (open || !userId || unreadCount === 0) return;
    const now = new Date().toISOString();
    setLastReadAt(now);
    await supabase.from("user_notification_reads").upsert({ user_id: userId, last_read_at: now }, { onConflict: "user_id" });
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={handleOpen}
        className="relative w-9 h-9 rounded-full bg-surface border border-border shadow-md flex items-center justify-center text-muted"
        title="Уведомления"
      >
        <IconBell />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[16px] h-[16px] rounded-full bg-[#A34B36] text-white text-[10px] font-bold flex items-center justify-center px-1">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-[320px] max-h-[400px] overflow-y-auto rounded-lg border border-border bg-surface shadow-lg p-1.5 flex flex-col gap-1">
          <div className="px-2 py-1.5 text-[11px] uppercase tracking-wide text-mutedLight">Уведомления</div>
          {notifications.length === 0 ? (
            <div className="px-2 py-3 text-[13px] text-muted">Пока ничего нет.</div>
          ) : (
            notifications.map((n) => (
              <div key={n.id} className="px-2 py-2 rounded-md text-[12.5px] flex flex-col gap-0.5 border-b border-borderSoft last:border-b-0">
                <span className="text-ink">{n.message}</span>
                <span className="text-[10.5px] text-mutedLight">{formatWhen(n.created_at)}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
