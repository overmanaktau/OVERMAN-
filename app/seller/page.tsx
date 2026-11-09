"use client";

import { useCallback, useEffect, useState } from "react";
import { Nunito } from "next/font/google";
import { authFetch } from "@/lib/apiClient";
import { getErrorMessage } from "@/lib/errors";
import { trim2Ru } from "@/lib/numFormat";
import type { CitySellers } from "@/lib/sellers/overview";

// Оформление как у кабинета продавца seller.overman.kz: кремовый фон, большие скруглённые плитки, шрифт Nunito, яркие статусные цвета.
const nunito = Nunito({ subsets: ["latin", "cyrillic"], weight: ["500", "700", "800", "900"] });

type Response = { stores: { code: string; label: string }[]; store: string; data: CitySellers };

const INK = "#261a52";
const LABEL = "#8a7cc0";
const money = (n: number) => `${trim2Ru(n)} ₸`;
const pct = (n: number) => `${trim2Ru(n)}%`;
const MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const timeAlmaty = (iso: string) => new Intl.DateTimeFormat("ru-RU", { timeZone: "Asia/Almaty", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

// Те же цвета, что в кабинете продавца: от 100% зелёный, от 85% оранжевый, ниже красный.
const statusColor = (n: number | null) => (n === null ? LABEL : n >= 100 ? "#12b886" : n >= 85 ? "#f5a524" : "#ff5c7a");

function Tile({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-[22px] px-5 py-4" style={{ background: "rgba(38,26,82,0.07)" }}>
      <p className="text-xs font-extrabold" style={{ color: LABEL }}>{label}</p>
      <p className="text-[22px] leading-tight font-black mt-1" style={{ color: color ?? INK }}>{value}</p>
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
    <div
      className={`${nunito.className} max-w-6xl rounded-[32px] p-4 sm:p-7`}
      style={{ background: "linear-gradient(160deg,#fffbe0 0%,#f6f8cf 55%,#eef5c4 100%)", color: INK }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <h1 className="text-[26px] sm:text-[30px] font-black leading-tight">Продавцы: кто как идёт</h1>
          {d && <p className="text-sm font-extrabold mt-1" style={{ color: LABEL }}>{month} · день {d.day} из {d.daysInMonth}</p>}
        </div>
        {resp && resp.stores.length > 1 && (
          <div className="flex gap-2">
            {resp.stores.map((s) => (
              <button
                key={s.code}
                type="button"
                onClick={() => load(s.code)}
                className="px-5 py-2.5 rounded-full text-sm font-extrabold"
                style={store === s.code ? { background: "#6d3df5", color: "#fff" } : { background: "#fff", color: INK }}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {error && <p className="text-sm font-extrabold mb-3" style={{ color: "#ff5c7a" }}>{error}</p>}
      {!d && loading && <p className="text-sm font-extrabold" style={{ color: LABEL }}>Загрузка…</p>}

      {d && (
        <div className={loading ? "opacity-60 transition-opacity" : ""}>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-5">
            <Tile label="Оборот месяца" value={money(d.team.turnover)} />
            <Tile label="План команды" value={money(d.team.plan)} />
            <Tile label="Выполнение" value={d.team.fulfillment === null ? "—" : pct(d.team.fulfillment)} color={statusColor(d.team.fulfillment)} />
            <Tile label="Прогноз на месяц" value={money(d.team.forecast)} />
            <Tile label="Прогноз к плану" value={d.team.forecastPct === null ? "—" : pct(d.team.forecastPct)} color={statusColor(d.team.forecastPct)} />
            <Tile label="Сегодня" value={money(d.team.today)} />
            <Tile label="Неделя" value={money(d.team.week)} />
            <Tile label="Чеков" value={trim2Ru(d.team.receipts)} />
            <Tile label="Средний чек" value={d.team.avgCheck === null ? "—" : money(d.team.avgCheck)} />
          </div>

          <div className="rounded-[28px] p-4 sm:p-6" style={{ background: "rgba(255,255,255,0.7)" }}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[900px]">
                <thead>
                  <tr className="text-left text-xs font-extrabold" style={{ color: LABEL }}>
                    <th className="px-3 py-2 w-8">#</th>
                    <th className="px-3 py-2">Продавец</th>
                    <th className="px-3 py-2 text-right">Оборот</th>
                    <th className="px-3 py-2 text-right">План</th>
                    <th className="px-3 py-2 min-w-[170px]">Выполнение</th>
                    <th className="px-3 py-2 text-right">Ставка</th>
                    <th className="px-3 py-2 text-right">Бонус сейчас</th>
                    <th className="px-3 py-2 text-right">Прогноз %</th>
                    <th className="px-3 py-2 text-right">Сегодня</th>
                    <th className="px-3 py-2 text-right">Неделя</th>
                    <th className="px-3 py-2 text-right">Чеки</th>
                  </tr>
                </thead>
                <tbody>
                  {d.rows.map((r, i) => (
                    <tr key={r.id} style={{ borderTop: "1px solid rgba(38,26,82,0.08)" }}>
                      <td className="px-3 py-3.5 font-extrabold" style={{ color: LABEL }}>{i + 1}</td>
                      <td className="px-3 py-3.5 font-black text-[15px]">{r.name}</td>
                      <td className="px-3 py-3.5 text-right whitespace-nowrap font-extrabold">{money(r.turnover)}</td>
                      <td className="px-3 py-3.5 text-right whitespace-nowrap font-bold" style={{ color: LABEL }}>{r.plan === null ? "—" : money(r.plan)}</td>
                      <td className="px-3 py-3.5">
                        {r.fulfillment === null ? (
                          <span style={{ color: LABEL }}>—</span>
                        ) : (
                          <div className="flex items-center gap-2.5">
                            <div className="h-3 flex-1 rounded-full min-w-[70px] overflow-hidden" style={{ background: "#e5defa" }}>
                              <div className="h-full rounded-full" style={{ width: `${Math.min(100, r.fulfillment)}%`, background: statusColor(r.fulfillment) }} />
                            </div>
                            <span className="text-sm font-black w-16 text-right" style={{ color: statusColor(r.fulfillment) }}>{pct(r.fulfillment)}</span>
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-3.5 text-right font-extrabold">{r.rate === null ? "—" : pct(r.rate)}</td>
                      <td className="px-3 py-3.5 text-right whitespace-nowrap font-black text-[15px]" style={{ color: "#6d3df5" }}>{r.bonus === null ? "—" : money(r.bonus)}</td>
                      <td className="px-3 py-3.5 text-right font-black" style={{ color: statusColor(r.forecastPct) }}>{r.forecastPct === null ? "—" : pct(r.forecastPct)}</td>
                      <td className="px-3 py-3.5 text-right whitespace-nowrap font-bold">{money(r.today)}</td>
                      <td className="px-3 py-3.5 text-right whitespace-nowrap font-bold">{money(r.week)}</td>
                      <td className="px-3 py-3.5 text-right font-extrabold">{trim2Ru(r.receipts)}</td>
                    </tr>
                  ))}
                  {d.rows.length === 0 && (
                    <tr>
                      <td colSpan={11} className="px-3 py-8 text-center font-extrabold" style={{ color: LABEL }}>В этом месяце продаж пока нет.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {d.noSales.length > 0 && <p className="text-xs font-extrabold mt-4" style={{ color: LABEL }}>Нет продаж в этом месяце: {d.noSales.join(", ")}</p>}
          <p className="text-xs font-bold mt-1.5" style={{ color: LABEL }}>
            Данные с учётом возвратов. Бонус сейчас = оборот × ставка (выполнение 0–85% — 2%, 86–90% — 2,5%, 91–99% — 3%, от 100% — 4%). Прогноз — по текущему темпу на дни месяца. Обновлено в {timeAlmaty(d.updatedAt)}.
          </p>
        </div>
      )}
    </div>
  );
}
