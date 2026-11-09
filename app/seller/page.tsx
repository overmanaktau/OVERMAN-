"use client";

import { useCallback, useEffect, useState } from "react";
import { authFetch } from "@/lib/apiClient";
import { getErrorMessage } from "@/lib/errors";
import { trim2Ru } from "@/lib/numFormat";
import type { CitySellers } from "@/lib/sellers/overview";

type Response = { stores: { code: string; label: string }[]; store: string; data: CitySellers };

const money = (n: number) => `${trim2Ru(n)} ₸`;
const pct = (n: number) => `${trim2Ru(n)}%`;
const MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const timeAlmaty = (iso: string) => new Intl.DateTimeFormat("ru-RU", { timeZone: "Asia/Almaty", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

// Зелёный — план выполнен (100% и выше), красный — ниже.
const pctColor = (n: number | null) => (n === null ? "text-muted" : n >= 100 ? "text-emerald-600" : "text-red-600");

function Card({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-surface border border-border rounded-card px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className={`text-lg font-semibold mt-0.5 ${color ?? "text-ink"}`}>{value}</p>
    </div>
  );
}

export default function SellerPage() {
  const [store, setStore] = useState<string | null>(null);
  const [resp, setResp] = useState<Response | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (code: string | null) => {
    setLoading(true);
    try {
      const r = (await authFetch(`/api/sellers${code ? `?store=${code}` : ""}`)) as Response;
      setResp(r);
      setStore(r.store);
      setError(null);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(null);
  }, [load]);

  // обновляем раз в 5 минут, пока страница открыта
  useEffect(() => {
    if (!store) return;
    const t = setInterval(() => load(store), 5 * 60 * 1000);
    return () => clearInterval(t);
  }, [store, load]);

  const d = resp?.data;
  const month = d ? `${MONTHS[Number(d.date.slice(5, 7)) - 1]} ${d.date.slice(0, 4)}` : "";

  return (
    <div className="max-w-6xl">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h1 className="font-serif text-2xl text-ink">Продавцы: кто как идёт</h1>
          {d && <p className="text-sm text-muted mt-0.5">{month} · день {d.day} из {d.daysInMonth}</p>}
        </div>
        {resp && resp.stores.length > 1 && (
          <div className="flex gap-1 bg-surface border border-border rounded-lg p-1">
            {resp.stores.map((s) => (
              <button
                key={s.code}
                type="button"
                onClick={() => load(s.code)}
                className={`px-4 py-1.5 rounded-md text-sm font-semibold ${store === s.code ? "bg-accent text-paper" : "text-muted hover:text-ink"}`}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
      {!d && loading && <p className="text-sm text-muted">Загрузка…</p>}

      {d && (
        <div className={loading ? "opacity-60 transition-opacity" : ""}>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-4">
            <Card label="Оборот месяца" value={money(d.team.turnover)} />
            <Card label="План команды" value={money(d.team.plan)} />
            <Card label="Выполнение" value={d.team.fulfillment === null ? "—" : pct(d.team.fulfillment)} color={pctColor(d.team.fulfillment)} />
            <Card label="Прогноз на месяц" value={money(d.team.forecast)} />
            <Card label="Прогноз к плану" value={d.team.forecastPct === null ? "—" : pct(d.team.forecastPct)} color={pctColor(d.team.forecastPct)} />
            <Card label="Сегодня" value={money(d.team.today)} />
            <Card label="Неделя" value={money(d.team.week)} />
            <Card label="Чеков" value={trim2Ru(d.team.receipts)} />
            <Card label="Средний чек" value={d.team.avgCheck === null ? "—" : money(d.team.avgCheck)} />
          </div>

          <div className="bg-surface border border-border rounded-card overflow-x-auto">
            <table className="w-full text-sm min-w-[860px]">
              <thead>
                <tr className="text-left text-xs text-muted border-b border-border">
                  <th className="px-3 py-2.5 font-medium w-8">#</th>
                  <th className="px-3 py-2.5 font-medium">Продавец</th>
                  <th className="px-3 py-2.5 font-medium text-right">Оборот</th>
                  <th className="px-3 py-2.5 font-medium text-right">План</th>
                  <th className="px-3 py-2.5 font-medium min-w-[150px]">Выполнение</th>
                  <th className="px-3 py-2.5 font-medium text-right">Ставка</th>
                  <th className="px-3 py-2.5 font-medium text-right">Бонус сейчас</th>
                  <th className="px-3 py-2.5 font-medium text-right">Прогноз %</th>
                  <th className="px-3 py-2.5 font-medium text-right">Сегодня</th>
                  <th className="px-3 py-2.5 font-medium text-right">Неделя</th>
                  <th className="px-3 py-2.5 font-medium text-right">Чеки</th>
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r, i) => (
                  <tr key={r.id} className="border-b border-borderSoft last:border-0">
                    <td className="px-3 py-2.5 text-muted">{i + 1}</td>
                    <td className="px-3 py-2.5 font-medium text-ink">{r.name}</td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">{money(r.turnover)}</td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap text-muted">{r.plan === null ? "—" : money(r.plan)}</td>
                    <td className="px-3 py-2.5">
                      {r.fulfillment === null ? (
                        <span className="text-muted">—</span>
                      ) : (
                        <div className="flex items-center gap-2">
                          <div className="h-2 flex-1 rounded-full bg-borderSoft overflow-hidden min-w-[60px]">
                            <div className={`h-full rounded-full ${r.fulfillment >= 100 ? "bg-emerald-500" : "bg-red-500"}`} style={{ width: `${Math.min(100, r.fulfillment)}%` }} />
                          </div>
                          <span className={`text-xs font-semibold w-14 text-right ${pctColor(r.fulfillment)}`}>{pct(r.fulfillment)}</span>
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right">{r.rate === null ? "—" : pct(r.rate)}</td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap font-medium">{r.bonus === null ? "—" : money(r.bonus)}</td>
                    <td className={`px-3 py-2.5 text-right font-semibold ${pctColor(r.forecastPct)}`}>{r.forecastPct === null ? "—" : pct(r.forecastPct)}</td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">{money(r.today)}</td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">{money(r.week)}</td>
                    <td className="px-3 py-2.5 text-right">{trim2Ru(r.receipts)}</td>
                  </tr>
                ))}
                {d.rows.length === 0 && (
                  <tr>
                    <td colSpan={11} className="px-3 py-6 text-center text-muted">В этом месяце продаж пока нет.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {d.noSales.length > 0 && <p className="text-xs text-muted mt-3">Нет продаж в этом месяце: {d.noSales.join(", ")}</p>}
          <p className="text-xs text-muted mt-1">
            Данные с учётом возвратов. Бонус сейчас = оборот × ставка (выполнение 0–85% — 2%, 86–90% — 2,5%, 91–99% — 3%, от 100% — 4%). Прогноз — по текущему темпу на дни месяца. Обновлено в {timeAlmaty(d.updatedAt)}.
          </p>
        </div>
      )}
    </div>
  );
}
