"use client";

import KpiCard from "@/components/KpiCard";
import { useAuth } from "@/components/AuthGate";

// Demo data for now — this is exactly what stage 3 (Supabase) will
// replace with real aggregates from traffic_entries / extra_expenses.
const PERIODS = ["Прошлая неделя", "Эта неделя", "С начала месяца", "30 дней", "Всё время"];

const TRAFFIC = [
  { day: "Пн", plan: 96, fact: 88 },
  { day: "Вт", plan: 104, fact: 98 },
  { day: "Ср", plan: 98, fact: 80 },
  { day: "Чт", plan: 112, fact: 106 },
  { day: "Пт", plan: 122, fact: 118 },
  { day: "Сб", plan: 130, fact: 112 },
  { day: "Вс", plan: 118, fact: 96 },
];

const CHANNELS = [
  { name: "TikTok", amount: "612 000 ₸", pct: 34, color: "bg-[#17140F]" },
  { name: "Instagram", amount: "438 000 ₸", pct: 24, color: "bg-accent" },
  { name: "Instagram паблик", amount: "320 000 ₸", pct: 18, color: "bg-[#6B7A5E]" },
  { name: "Раздача флаеров", amount: "250 000 ₸", pct: 14, color: "bg-[#A89A78]" },
  { name: "2ГИС карта", amount: "180 000 ₸", pct: 10, color: "bg-[#C9BFA5]" },
];

export default function StatisticsPage() {
  const { isAdmin, permissions } = useAuth();
  if (!isAdmin && !permissions["marketing.statistics"].canView) {
    return (
      <div className="bg-white border border-border rounded-card p-8 max-w-md">
        <p className="text-sm text-muted">У вас нет доступа к разделу «Статистика».</p>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-1">
        <div className="text-xs text-mutedLight">Маркетинг</div>
        <div className="flex items-center gap-2.5">
          <h1 className="font-serif text-[28px] font-semibold m-0">Статистика</h1>
          <span className="text-[11px] tracking-wide uppercase text-muted bg-[#EDE8DC] border border-border rounded-full px-2.5 py-1">
            демо-данные
          </span>
        </div>
      </div>

      {/* Period selector */}
      <div className="flex items-center gap-1.5 bg-white border border-border rounded-card p-1.5 w-fit">
        {PERIODS.map((p, i) => (
          <button
            key={p}
            type="button"
            className={`font-sans text-[13px] rounded-md px-3.5 py-2 ${
              i === 1 ? "bg-accent text-paper font-bold" : "text-muted font-medium"
            }`}
          >
            {p}
          </button>
        ))}
        <div className="w-px h-5 bg-border mx-0.5" />
        <button type="button" className="text-[13px] text-muted font-medium px-3.5 py-2">
          Свой период
        </button>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-5 gap-3.5">
        <KpiCard label="Выполнение плана по трафику" value="93%" note="7 654 из 8 200 план" />
        <KpiCard
          label="Общий расход на маркетинг"
          value="1 800 000 ₸"
          note="▲ 8% к прошлой неделе"
          noteTone="positive"
        />
        <KpiCard
          label="Цена одного посетителя"
          value="235 ₸"
          note="▼ 3% к прошлой неделе"
          noteTone="negative"
        />
        <KpiCard
          label="Цена одного покупателя"
          value="3 670 ₸"
          note="▲ 2% к прошлой неделе"
          noteTone="positive"
        />
        <KpiCard label="Маркетинг, % от среднего чека" value="14,1%" note="средний чек 26 000 ₸" />
      </div>

      {/* Traffic chart + channel spend */}
      <div className="grid grid-cols-[1.35fr_1fr] gap-4 items-stretch">
        <div className="bg-white border border-border rounded-card px-6 pt-[22px] pb-[18px] flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div className="text-[15px] font-bold">Трафик: план / факт</div>
            <div className="flex items-center gap-4 text-xs text-muted">
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm bg-[#D8D2C4] inline-block" /> План
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm bg-accent inline-block" /> Факт
              </span>
            </div>
          </div>
          <div className="grid grid-cols-7 gap-3.5 items-end h-[170px] px-1">
            {TRAFFIC.map((d) => (
              <div key={d.day} className="flex flex-col items-center gap-2 h-full justify-end">
                <div className="flex items-end gap-1 h-[130px]">
                  <div className="w-4 bg-[#D8D2C4] rounded-t-sm" style={{ height: `${d.plan}px` }} />
                  <div className="w-4 bg-accent rounded-t-sm" style={{ height: `${d.fact}px` }} />
                </div>
                <div className="text-[11px] text-mutedLight">{d.day}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5">
          <div className="text-[15px] font-bold">Расходы по каналам</div>
          <div className="flex flex-col gap-3.5">
            {CHANNELS.map((c) => (
              <div key={c.name} className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between text-[13px]">
                  <span className="font-semibold">{c.name}</span>
                  <span className="text-muted num">
                    {c.amount} · {c.pct}%
                  </span>
                </div>
                <div className="h-1.5 bg-borderSoft rounded-full overflow-hidden">
                  <div className={`h-full ${c.color}`} style={{ width: `${c.pct}%` }} />
                </div>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between pt-2.5 border-t border-borderSoft text-[13px] font-bold">
            <span>Итого</span>
            <span className="num">1 800 000 ₸</span>
          </div>
        </div>
      </div>
    </>
  );
}
