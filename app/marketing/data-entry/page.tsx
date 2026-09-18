"use client";

import { useMemo, useState } from "react";

type DayRow = {
  date: string; // "01.09"
  weekday: string;
  weekend: boolean;
  trafficPlan: number | "";
  trafficFact: number | "";
  instagram: number | "";
  tiktok: number | "";
  instagramPublic: number | "";
  flyer: number | "";
  twoGis: number | "";
};

type ExpenseRow = {
  date: string;
  category: string;
  amount: number;
  comment: string;
};

const WEEKDAYS = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

// September 2026 starts on a Tuesday — computed once for the demo month.
function buildSeptemberRows(): DayRow[] {
  const daysInMonth = 30;
  const startWeekdayIndex = 2; // Tuesday
  const rows: DayRow[] = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const weekdayIndex = (startWeekdayIndex + (d - 1)) % 7;
    const weekday = WEEKDAYS[weekdayIndex];
    rows.push({
      date: `${String(d).padStart(2, "0")}.09`,
      weekday,
      weekend: weekday === "Сб" || weekday === "Вс",
      trafficPlan: "",
      trafficFact: "",
      instagram: "",
      tiktok: "",
      instagramPublic: "",
      flyer: "",
      twoGis: "",
    });
  }
  return rows;
}

const NUMERIC_FIELDS: (keyof DayRow)[] = [
  "trafficPlan",
  "trafficFact",
  "instagram",
  "tiktok",
  "instagramPublic",
  "flyer",
  "twoGis",
];

export default function DataEntryPage() {
  const [rows, setRows] = useState<DayRow[]>(buildSeptemberRows);
  const [locked, setLocked] = useState(false);
  const [expenses, setExpenses] = useState<ExpenseRow[]>([
    { date: "03.09", category: "Полиграфия — вывеска у входа", amount: 45000, comment: "Обновление баннера к сезону" },
    { date: "09.09", category: "Услуги фотографа", amount: 60000, comment: "Съёмка для соцсетей и карточек товара" },
  ]);

  function updateCell(index: number, field: keyof DayRow, value: string) {
    if (locked) return;
    setRows((prev) => {
      const next = [...prev];
      const num = value === "" ? "" : Number(value);
      next[index] = { ...next[index], [field]: num } as DayRow;
      return next;
    });
  }

  const totals = useMemo(() => {
    const sum = (field: keyof DayRow) =>
      rows.reduce((acc, r) => acc + (typeof r[field] === "number" ? (r[field] as number) : 0), 0);
    return {
      trafficPlan: sum("trafficPlan"),
      trafficFact: sum("trafficFact"),
      instagram: sum("instagram"),
      tiktok: sum("tiktok"),
      instagramPublic: sum("instagramPublic"),
      flyer: sum("flyer"),
      twoGis: sum("twoGis"),
    };
  }, [rows]);

  const channelTotal =
    totals.instagram + totals.tiktok + totals.instagramPublic + totals.flyer + totals.twoGis;
  const expensesTotal = expenses.reduce((acc, e) => acc + e.amount, 0);

  function handleSaveMonth() {
    // TODO (этап 2): отправить rows в Supabase (upsert в traffic_entries)
    // и поставить month_status.locked = true. Пока просто блокируем
    // редактирование на клиенте, чтобы поведение было понятно.
    setLocked(true);
  }

  return (
    <>
      <div className="flex flex-col gap-1">
        <div className="text-xs text-mutedLight">Маркетинг</div>
        <div className="flex items-center gap-2.5">
          <h1 className="font-serif text-[28px] font-semibold m-0">Внесение данных</h1>
          {locked && (
            <span className="text-[11px] tracking-wide uppercase text-muted bg-[#EDE8DC] border border-border rounded-full px-2.5 py-1">
              месяц закрыт — только полный доступ
            </span>
          )}
        </div>
        <p className="text-sm text-muted max-w-xl mt-1">
          Трафик и расходы по каналам вводятся вручную за каждый день. После сохранения месяца
          редактировать данные может только пользователь с полным доступом.
        </p>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 bg-white border border-border rounded-card p-1.5">
          <button type="button" aria-label="Предыдущий месяц" className="w-[30px] h-[30px] rounded-md text-muted">
            ‹
          </button>
          <div className="text-[15px] font-bold min-w-[150px] text-center">Сентябрь 2026</div>
          <button type="button" aria-label="Следующий месяц" className="w-[30px] h-[30px] rounded-md text-muted">
            ›
          </button>
        </div>
        <div className="text-xs text-[#6B6455]">Точка 1</div>
      </div>

      <div className="bg-white border border-border rounded-card px-6 pt-[22px] pb-5 flex flex-col gap-3.5">
        <div className="text-[15px] font-bold">Трафик и расходы по каналам — с 1 по 30 сентября</div>

        <div className="max-h-[460px] overflow-y-auto rounded-md">
          <div className="sticky top-0 z-10 bg-white grid grid-cols-[60px_46px_84px_84px_78px_78px_96px_74px_74px] gap-2 pb-2 text-[10.5px] uppercase tracking-wide text-mutedLight border-b border-border">
            <div>Дата</div>
            <div>День</div>
            <div>Трафик план</div>
            <div>Трафик факт</div>
            <div>Instagram</div>
            <div>TikTok</div>
            <div>Insta паблик</div>
            <div>Флаер</div>
            <div>2ГИС</div>
          </div>

          {rows.map((row, i) => (
            <div
              key={row.date}
              className={`grid grid-cols-[60px_46px_84px_84px_78px_78px_96px_74px_74px] gap-2 items-center py-1 border-b border-[#F6F3EC] ${
                row.weekend ? "bg-weekendTint" : ""
              }`}
            >
              <div className="text-[12.5px] text-muted">{row.date}</div>
              <div className="text-[12.5px] text-mutedLight">{row.weekday}</div>
              {NUMERIC_FIELDS.map((field) => (
                <input
                  key={field}
                  type="number"
                  disabled={locked}
                  value={row[field] === "" ? "" : (row[field] as number)}
                  onChange={(e) => updateCell(i, field, e.target.value)}
                  placeholder="0"
                  className="w-full box-border text-right text-[12.5px] rounded-[5px] border border-cellBorder px-1.5 py-1 disabled:bg-[#F1EEE6] disabled:text-muted focus:outline-none focus:border-accent"
                />
              ))}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-[60px_46px_84px_84px_78px_78px_96px_74px_74px] gap-2 items-center pt-2.5 border-t-2 border-[#E4DFC8] text-[12.5px] font-bold">
          <div className="col-span-2">Итого</div>
          <div className="num">{totals.trafficPlan || 0}</div>
          <div className="num">{totals.trafficFact || 0}</div>
          <div className="num">{totals.instagram.toLocaleString("ru-RU")}</div>
          <div className="num">{totals.tiktok.toLocaleString("ru-RU")}</div>
          <div className="num">{totals.instagramPublic.toLocaleString("ru-RU")}</div>
          <div className="num">{totals.flyer.toLocaleString("ru-RU")}</div>
          <div className="num">{totals.twoGis.toLocaleString("ru-RU")}</div>
        </div>

        <div className="flex items-center justify-between pt-2 border-t border-borderSoft">
          <div className="text-[13px] text-muted">
            Итого расходов на маркетинг за месяц (по каналам):{" "}
            <span className="num text-ink font-bold">{channelTotal.toLocaleString("ru-RU")} ₸</span>
          </div>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              disabled={locked}
              onClick={() => setRows(buildSeptemberRows())}
              className="text-[13px] font-semibold text-muted border border-[#DDD6C8] rounded-lg px-4 py-2.5 disabled:opacity-50"
            >
              Отмена
            </button>
            <button
              type="button"
              disabled={locked}
              onClick={handleSaveMonth}
              className="text-[13px] font-bold text-paper bg-accent rounded-lg px-[18px] py-2.5 disabled:opacity-50"
            >
              {locked ? "Месяц сохранён" : "Сохранить месяц"}
            </button>
          </div>
        </div>
      </div>

      <div className="bg-white border border-border rounded-card px-6 py-[22px] flex flex-col gap-3.5">
        <div className="flex flex-col gap-0.5">
          <div className="text-[15px] font-bold">Дополнительные расходы на маркетинг</div>
          <div className="text-[12.5px] text-muted">
            Сюда вносятся расходы, не относящиеся к таблице выше — по логике ДДС: дата, статья,
            сумма, комментарий.
          </div>
        </div>

        <div className="grid grid-cols-[90px_220px_120px_1fr] gap-3 pb-2.5 text-[10.5px] uppercase tracking-wide text-mutedLight border-b border-border">
          <div>Дата</div>
          <div>Статья</div>
          <div>Сумма</div>
          <div>Комментарий</div>
        </div>

        {expenses.map((e, i) => (
          <div
            key={i}
            className="grid grid-cols-[90px_220px_120px_1fr] gap-3 py-2.5 border-b border-borderSoft items-center text-[13px]"
          >
            <div>{e.date}</div>
            <div>{e.category}</div>
            <div className="num">{e.amount.toLocaleString("ru-RU")} ₸</div>
            <div className="text-muted">{e.comment}</div>
          </div>
        ))}

        <button
          type="button"
          onClick={() =>
            setExpenses((prev) => [...prev, { date: "", category: "", amount: 0, comment: "" }])
          }
          className="flex items-center gap-2 text-[13px] font-semibold text-accent py-3 text-left"
        >
          + Добавить расход
        </button>

        <div className="flex items-center justify-between pt-2.5 border-t border-borderSoft text-[13px] font-bold">
          <span>Общая сумма расходов</span>
          <span className="num">{expensesTotal.toLocaleString("ru-RU")} ₸</span>
        </div>
      </div>
    </>
  );
}
