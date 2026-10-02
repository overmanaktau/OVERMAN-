"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { authFetch } from "@/lib/apiClient";
import { useAuth } from "@/components/AuthGate";
import { useSiteVersion } from "@/components/SiteVersion";
import { getErrorMessage } from "@/lib/errors";

type ShiftKind = "morning" | "evening" | "off";

const KINDS: { key: ShiftKind; label: string; short: string; chip: string }[] = [
  { key: "morning", label: "Утро", short: "Утро", chip: "bg-[#F3E7C9] text-[#7A5A12]" },
  { key: "evening", label: "Вечер", short: "Вечер", chip: "bg-[#DCE4F0] text-[#35507A]" },
  { key: "off", label: "Выходной", short: "Вых.", chip: "bg-[#EDE8DC] text-muted" },
];

// Click-to-cycle order on the desktop grid: empty → утро → вечер → выходной → empty.
const CYCLE: (ShiftKind | null)[] = [null, "morning", "evening", "off"];

const WEEKDAYS_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const WEEKDAYS_FULL = ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"];
const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const MONTHS_GEN = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];

function pad2(n: number) {
  return String(n).padStart(2, "0");
}
function ymd(d: Date) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function addDays(d: Date, n: number) {
  const next = new Date(d);
  next.setDate(next.getDate() + n);
  return next;
}
function mondayOf(d: Date) {
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = day.getDay();
  return addDays(day, dow === 0 ? -6 : 1 - dow);
}
// Index 0..6 of today within the Monday-first week.
function todayIndex() {
  const dow = new Date().getDay();
  return dow === 0 ? 6 : dow - 1;
}

function friendlyError(e: unknown): string {
  const message = getErrorMessage(e);
  if (/fetch|network|failed to fetch/i.test(message)) {
    return "Нет связи с сервером базы данных. Проверьте интернет-соединение и попробуйте снова.";
  }
  return `Не удалось выполнить операцию: ${message}`;
}

export default function SchedulePage() {
  const { isAdmin, permissions } = useAuth();
  const { mobileLayout } = useSiteVersion();
  const canEdit = isAdmin || permissions["schedule"].canEdit;

  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date()));
  const [selectedDay, setSelectedDay] = useState(todayIndex);
  const [roster, setRoster] = useState<{ id: string; name: string }[]>([]);
  const [shifts, setShifts] = useState<Record<string, ShiftKind>>({});
  const [loading, setLoading] = useState(true);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const todayKey = ymd(new Date());
  const weekEnd = days[6];

  useEffect(() => {
    let cancelled = false;
    authFetch("/api/schedule-employees")
      .then((data) => {
        if (cancelled) return;
        const list = ((data.roster ?? []) as { id: string; name: string }[]).slice();
        list.sort((a, b) => a.name.localeCompare(b.name, "ru"));
        setRoster(list);
      })
      .catch((e) => {
        if (!cancelled) setRosterError(friendlyError(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      setNotice(null);
      const { data, error: err } = await supabase
        .from("work_shifts")
        .select("user_id, shift_date, kind")
        .gte("shift_date", ymd(weekStart))
        .lte("shift_date", ymd(addDays(weekStart, 6)));
      if (cancelled) return;
      if (err) {
        setError(friendlyError(err));
        setShifts({});
      } else {
        const map: Record<string, ShiftKind> = {};
        for (const r of (data ?? []) as { user_id: string; shift_date: string; kind: ShiftKind }[]) {
          map[`${r.user_id}|${r.shift_date}`] = r.kind;
        }
        setShifts(map);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [weekStart]);

  async function setShift(userId: string, date: Date, kind: ShiftKind | null) {
    if (!canEdit) return;
    const dateStr = ymd(date);
    const key = `${userId}|${dateStr}`;
    const prev = shifts[key];
    setError(null);
    setNotice(null);
    setShifts((cur) => {
      const next = { ...cur };
      if (kind) next[key] = kind;
      else delete next[key];
      return next;
    });
    const { error: err } = kind
      ? await supabase
          .from("work_shifts")
          .upsert({ user_id: userId, shift_date: dateStr, kind }, { onConflict: "user_id,shift_date" })
      : await supabase.from("work_shifts").delete().eq("user_id", userId).eq("shift_date", dateStr);
    if (err) {
      setShifts((cur) => {
        const next = { ...cur };
        if (prev) next[key] = prev;
        else delete next[key];
        return next;
      });
      setError(friendlyError(err));
    }
  }

  function cycleShift(userId: string, date: Date) {
    const current = shifts[`${userId}|${ymd(date)}`] ?? null;
    const next = CYCLE[(CYCLE.indexOf(current) + 1) % CYCLE.length];
    void setShift(userId, date, next);
  }

  async function copyPreviousWeek() {
    if (!canEdit) return;
    if (
      Object.keys(shifts).length > 0 &&
      !window.confirm("На этой неделе уже есть смены — совпадающие дни будут заменены сменами прошлой недели. Продолжить?")
    ) {
      return;
    }
    setCopying(true);
    setError(null);
    setNotice(null);
    try {
      const prevStart = addDays(weekStart, -7);
      const { data, error: err } = await supabase
        .from("work_shifts")
        .select("user_id, shift_date, kind")
        .gte("shift_date", ymd(prevStart))
        .lte("shift_date", ymd(addDays(prevStart, 6)));
      if (err) throw err;
      const rows = ((data ?? []) as { user_id: string; shift_date: string; kind: ShiftKind }[]).map((r) => ({
        user_id: r.user_id,
        shift_date: ymd(addDays(parseYmd(r.shift_date), 7)),
        kind: r.kind,
      }));
      if (rows.length === 0) {
        setNotice("На прошлой неделе смен нет — копировать нечего.");
        return;
      }
      const { error: upErr } = await supabase.from("work_shifts").upsert(rows, { onConflict: "user_id,shift_date" });
      if (upErr) throw upErr;
      setShifts((cur) => {
        const next = { ...cur };
        for (const r of rows) next[`${r.user_id}|${r.shift_date}`] = r.kind;
        return next;
      });
      setNotice(`Скопировано смен: ${rows.length}.`);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setCopying(false);
    }
  }

  function goToWeek(offset: number) {
    setWeekStart((cur) => addDays(cur, offset * 7));
  }
  function goToCurrentWeek() {
    setWeekStart(mondayOf(new Date()));
    setSelectedDay(todayIndex());
  }

  function countFor(date: Date, kind: ShiftKind) {
    const dk = ymd(date);
    return roster.filter((e) => shifts[`${e.id}|${dk}`] === kind).length;
  }

  const rangeLabel = `${weekStart.getDate()} ${MONTHS_SHORT[weekStart.getMonth()]} – ${weekEnd.getDate()} ${
    MONTHS_SHORT[weekEnd.getMonth()]
  } ${weekEnd.getFullYear()}`;
  const shownError = error ?? rosterError;
  const isCurrentWeek = ymd(weekStart) === ymd(mondayOf(new Date()));

  const navButton =
    "text-[13px] font-semibold rounded-lg px-3.5 py-2 bg-surface border border-border text-muted disabled:opacity-50";

  return (
    <>
      <div className="flex flex-col gap-1">
        <div className="text-xs text-mutedLight">Общее</div>
        <h1 className="font-serif text-[28px] font-semibold m-0">График смен</h1>
        <p className="text-sm text-muted max-w-xl mt-1">
          {!canEdit
            ? "Кто в какую смену выходит."
            : mobileLayout
              ? "Выберите день и отметьте каждому сотруднику смену. Повторное нажатие снимает отметку."
              : "Кто в какую смену выходит. Нажмите на ячейку, чтобы переключить: утро → вечер → выходной → пусто."}
        </p>
        {shownError && <div className="text-sm text-[#A34B36]">{shownError}</div>}
        {notice && <div className="text-sm text-muted">{notice}</div>}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <button type="button" onClick={() => goToWeek(-1)} className={navButton} aria-label="Предыдущая неделя">
          ‹
        </button>
        <div className="text-[14px] font-semibold px-1">{rangeLabel}</div>
        <button type="button" onClick={() => goToWeek(1)} className={navButton} aria-label="Следующая неделя">
          ›
        </button>
        {!isCurrentWeek && (
          <button type="button" onClick={goToCurrentWeek} className={navButton}>
            Эта неделя
          </button>
        )}
        {canEdit && (
          <button type="button" onClick={copyPreviousWeek} disabled={copying} className={navButton}>
            {copying ? "Копирую…" : "Скопировать прошлую неделю"}
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap text-[11px] font-semibold uppercase tracking-wide">
        {KINDS.map((k) => (
          <span key={k.key} className={`rounded-full px-2.5 py-1 ${k.chip}`}>
            {k.label}
          </span>
        ))}
      </div>

      <div className="bg-surface border border-border rounded-card px-5 py-[22px] flex flex-col gap-3.5">
        {roster.length === 0 ? (
          <div className="text-sm text-muted">{rosterError ? "Не удалось загрузить сотрудников." : "Загрузка…"}</div>
        ) : mobileLayout ? (
          <div className="flex flex-col gap-3.5">
            <div className="grid grid-cols-7 gap-1">
              {days.map((d, i) => {
                const selected = i === selectedDay;
                const isToday = ymd(d) === todayKey;
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setSelectedDay(i)}
                    className={`flex flex-col items-center py-2 rounded-lg text-[11px] ${
                      selected
                        ? "bg-accent text-paper font-bold"
                        : isToday
                          ? "border border-accent text-ink font-semibold"
                          : "border border-borderSoft text-muted font-medium"
                    }`}
                  >
                    <span>{WEEKDAYS_SHORT[i]}</span>
                    <span className="text-[14px]">{d.getDate()}</span>
                  </button>
                );
              })}
            </div>
            <div className="flex flex-col gap-0.5">
              <div className="text-[15px] font-bold">
                {WEEKDAYS_FULL[selectedDay]}, {days[selectedDay].getDate()} {MONTHS_GEN[days[selectedDay].getMonth()]}
              </div>
              <div className="text-xs text-muted">
                Утро: {countFor(days[selectedDay], "morning")} · Вечер: {countFor(days[selectedDay], "evening")} ·
                Выходной: {countFor(days[selectedDay], "off")}
              </div>
            </div>
            <div className="flex flex-col gap-2">
              {roster.map((e) => {
                const current = shifts[`${e.id}|${ymd(days[selectedDay])}`];
                return (
                  <div key={e.id} className="flex flex-col gap-1.5 rounded-lg border border-borderSoft p-3">
                    <div className="text-[13px] font-semibold break-words">{e.name}</div>
                    <div className="grid grid-cols-3 gap-1.5">
                      {KINDS.map((k) => (
                        <button
                          key={k.key}
                          type="button"
                          disabled={!canEdit}
                          onClick={() => setShift(e.id, days[selectedDay], current === k.key ? null : k.key)}
                          className={`rounded-md py-2 text-[12px] font-semibold disabled:cursor-default ${
                            current === k.key ? k.chip : "border border-borderSoft text-mutedLight"
                          }`}
                        >
                          {k.label}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <div className="grid grid-cols-[minmax(110px,1.3fr)_repeat(7,minmax(0,1fr))] gap-1.5 pb-2 border-b border-border">
              <div className="text-[10.5px] uppercase tracking-wide text-mutedLight self-end">Сотрудник</div>
              {days.map((d, i) => (
                <div
                  key={i}
                  className={`flex flex-col items-center text-[11px] ${
                    ymd(d) === todayKey ? "text-accent font-bold" : "text-mutedLight font-medium"
                  }`}
                >
                  <span className="uppercase tracking-wide">{WEEKDAYS_SHORT[i]}</span>
                  <span className="text-[13px]">{d.getDate()}</span>
                </div>
              ))}
            </div>
            {roster.map((e) => (
              <div
                key={e.id}
                className="grid grid-cols-[minmax(110px,1.3fr)_repeat(7,minmax(0,1fr))] gap-1.5 py-1 items-center"
              >
                <div className="text-[13px] font-semibold break-words">{e.name}</div>
                {days.map((d, i) => {
                  const current = shifts[`${e.id}|${ymd(d)}`];
                  const kind = KINDS.find((k) => k.key === current);
                  const cellClass = `w-full rounded-md py-1.5 text-[11px] font-semibold ${
                    kind ? kind.chip : "border border-dashed border-border text-mutedLight"
                  }`;
                  return canEdit ? (
                    <button key={i} type="button" onClick={() => cycleShift(e.id, d)} className={cellClass}>
                      {kind ? kind.short : "+"}
                    </button>
                  ) : (
                    <div key={i} className={`${cellClass} text-center`}>
                      {kind ? kind.short : "·"}
                    </div>
                  );
                })}
              </div>
            ))}
            {(["morning", "evening"] as const).map((kind, idx) => (
              <div
                key={kind}
                className={`grid grid-cols-[minmax(110px,1.3fr)_repeat(7,minmax(0,1fr))] gap-1.5 py-1 items-center text-[12px] text-muted ${
                  idx === 0 ? "border-t border-border mt-1 pt-2" : ""
                }`}
              >
                <div className="font-semibold">{kind === "morning" ? "Утро, чел." : "Вечер, чел."}</div>
                {days.map((d, i) => (
                  <div key={i} className="text-center">
                    {countFor(d, kind)}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
        {loading && roster.length > 0 && <div className="text-xs text-mutedLight">Загрузка графика…</div>}
      </div>
    </>
  );
}
