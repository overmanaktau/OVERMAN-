"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Nunito } from "next/font/google";
import { getErrorMessage } from "@/lib/errors";
import { trim2Ru } from "@/lib/numFormat";
import type { CitySellers } from "@/lib/sellers/overview";

// Оформление скопировано с кабинета seller.overman.kz (фото владельца): белая страница, две крупные панели (плитки итогов и таблица), шрифт Nunito, яркие статусные цвета.
const nunito = Nunito({
  subsets: ["latin", "cyrillic"],
  weight: ["500", "700", "800", "900"],
});

type Response = {
  stores: { code: string; label: string }[];
  store: string;
  data: CitySellers;
};

const INK = "#261a52";
const LABEL = "#8a7cc0";
const PANEL = "#f6f4fb"; // крупная панель
const TILE = "#ebe8f5"; // плитка внутри панели
const money = (n: number) => `${trim2Ru(n)} ₸`;
const pct = (n: number) => `${trim2Ru(n)}%`;
const MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const timeAlmaty = (iso: string) =>
  new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Asia/Almaty",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));

// Те же цвета, что в кабинете продавца: от 100% зелёный, от 85% оранжевый, ниже красный.
const statusColor = (n: number | null) => (n === null ? LABEL : n >= 100 ? "#12b886" : n >= 85 ? "#f5a524" : "#ff5c7a");

function Tile({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-[22px] px-5 py-4" style={{ background: TILE, flex: "1 1 170px" }}>
      <p className="text-xs font-extrabold" style={{ color: LABEL }}>
        {label}
      </p>
      <p className="text-[22px] leading-tight font-black mt-1 whitespace-nowrap" style={{ color: color ?? INK }}>
        {value}
      </p>
    </div>
  );
}

export default function SellerPage() {
  const [store, setStore] = useState<string | null>(null);
  const [resp, setResp] = useState<Response | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [needLogin, setNeedLogin] = useState(false);
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const token = useRef(""); // пропуск только в памяти страницы: после обновления страницы пароль спрашивается снова

  const load = useCallback(async (code: string | null) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/sellers${code ? `?store=${code}` : ""}`, {
        cache: "no-store",
        headers: { Authorization: `Bearer ${token.current}` },
      });
      if (res.status === 401) {
        setNeedLogin(true);
        setResp(null);
        setError(null);
        return;
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Ошибка запроса (${res.status})`);
      setResp(body as Response);
      setStore((body as Response).store);
      setNeedLogin(false);
      setError(null);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setSigningIn(true);
    setError(null);
    try {
      const res = await fetch("/api/sellers/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ login, password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Ошибка входа (${res.status})`);
      token.current = body.token as string;
      setPassword("");
      await load(null);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSigningIn(false);
    }
  }

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

  const field = "w-full rounded-2xl px-4 py-3 text-base font-bold outline-none border-2 border-transparent focus:border-[#6d3df5]";

  return (
    <div className={`${nunito.className} fixed inset-0 overflow-auto`} style={{ background: "#ffffff", color: INK }}>
      <div className="max-w-6xl mx-auto p-3 sm:p-6">
        {needLogin && (
          <form onSubmit={signIn} className="max-w-sm mx-auto mt-[12vh] rounded-[28px] p-7 flex flex-col gap-4" style={{ background: PANEL }}>
            <h1 className="text-[26px] font-black leading-tight">Продавцы: кто как идёт</h1>
            <p className="text-sm font-extrabold" style={{ color: LABEL }}>
              Введите логин и пароль. Пароль спрашивается при каждом открытии и обновлении страницы.
            </p>
            <input className={field} style={{ background: TILE, color: INK }} placeholder="Логин" autoComplete="username" autoCapitalize="none" value={login} onChange={(e) => setLogin(e.target.value)} />
            <input className={field} style={{ background: TILE, color: INK }} placeholder="Пароль" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            {error && (
              <p className="text-sm font-extrabold" style={{ color: "#ff5c7a" }}>
                {error}
              </p>
            )}
            <button type="submit" disabled={signingIn || !login || !password} className="rounded-full py-3 text-base font-black text-white disabled:opacity-50" style={{ background: "#6d3df5" }}>
              {signingIn ? "Вхожу…" : "Войти"}
            </button>
          </form>
        )}

        {!needLogin && (
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div className="rounded-full px-5 py-2.5 text-sm font-black text-white" style={{ background: "#6d3df5" }}>
              {d ? `${month} · день ${d.day} из ${d.daysInMonth}` : "Загрузка…"}
            </div>
            {resp && resp.stores.length > 1 && (
              <div className="flex gap-2">
                {resp.stores.map((c) => (
                  <button
                    key={c.code}
                    type="button"
                    onClick={() => load(c.code)}
                    className="px-5 py-2.5 rounded-full text-sm font-extrabold"
                    style={store === c.code ? { background: "#6d3df5", color: "#fff" } : { background: PANEL, color: INK }}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {!needLogin && error && (
          <p className="text-sm font-extrabold mb-3" style={{ color: "#ff5c7a" }}>
            {error}
          </p>
        )}

        {!needLogin && d && (
          <div className={loading ? "opacity-60 transition-opacity" : ""}>
            <div className="rounded-[32px] p-4 sm:p-5" style={{ background: PANEL }}>
              <div className="flex flex-wrap gap-3">
                <Tile label="Оборот месяца" value={money(d.team.turnover)} />
                <Tile label="План команды" value={money(d.team.plan)} />
                <Tile label="Выполнение" value={d.team.fulfillment === null ? "—" : pct(d.team.fulfillment)} color={statusColor(d.team.fulfillment)} />
                <Tile label="Прогноз на месяц" value={money(d.team.forecast)} />
                <Tile label="Прогноз к плану" value={d.team.forecastPct === null ? "—" : pct(d.team.forecastPct)} color={statusColor(d.team.forecastPct)} />
                <Tile label="Сегодня" value={money(d.team.today)} />
                <Tile label="Неделя" value={money(d.team.week)} />
                <Tile label="Чеков" value={trim2Ru(d.team.receipts)} />
                <Tile label="Средний чек" value={d.team.avgCheck === null ? "—" : money(d.team.avgCheck)} />
                <Tile label="Глубина чека" value={d.team.depth === null ? "—" : trim2Ru(d.team.depth)} />
              </div>
              <p className="text-xs font-bold mt-3 px-1" style={{ color: LABEL }}>
                Данные с учётом возвратов, обновление раз в 5 минут (последнее: {timeAlmaty(d.updatedAt)}). Прогноз = текущий темп × дней в месяце.
              </p>
            </div>

            <div className="rounded-[32px] p-4 sm:p-6 mt-4" style={{ background: PANEL }}>
              <h1 className="text-[24px] sm:text-[28px] font-black leading-tight mb-3">Продавцы: кто как идёт</h1>
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[980px]">
                  <thead>
                    <tr className="text-left text-xs font-extrabold" style={{ color: LABEL }}>
                      <th className="px-3 py-2 w-8">#</th>
                      <th className="px-3 py-2">Продавец</th>
                      <th className="px-3 py-2 text-right">Оборот</th>
                      <th className="px-3 py-2 text-right">План</th>
                      <th className="px-3 py-2 min-w-[190px]">Выполнение</th>
                      <th className="px-3 py-2 text-right">Ставка</th>
                      <th className="px-3 py-2 text-right">Бонус сейчас</th>
                      <th className="px-3 py-2 text-right">Прогноз %</th>
                      <th className="px-3 py-2 text-right" title="Оборот за сегодняшний день с учётом возвратов">
                        Сегодня
                      </th>
                      <th className="px-3 py-2 text-right" title="Оборот с понедельника по сегодня с учётом возвратов">
                        Неделя
                      </th>
                      <th className="px-3 py-2 text-right">Чеки</th>
                      <th className="px-3 py-2 text-right" title="Сколько товаров в среднем в одном чеке за месяц">
                        Глубина чека
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.rows.map((r, i) => (
                      <tr key={r.id} style={{ borderTop: "1px solid rgba(38,26,82,0.08)" }}>
                        <td className="px-3 py-3.5 font-extrabold" style={{ color: LABEL }}>
                          {i + 1}
                        </td>
                        <td className="px-3 py-3.5 font-black text-[15px] whitespace-nowrap">{r.name}</td>
                        <td className="px-3 py-3.5 text-right whitespace-nowrap font-extrabold">{money(r.turnover)}</td>
                        <td className="px-3 py-3.5 text-right whitespace-nowrap font-bold" style={{ color: LABEL }}>
                          {r.plan === null ? "—" : money(r.plan)}
                        </td>
                        <td className="px-3 py-3.5">
                          {r.fulfillment === null ? (
                            <span style={{ color: LABEL }}>—</span>
                          ) : (
                            <div className="flex items-center gap-3">
                              <span className="text-sm font-black w-[72px] shrink-0" style={{ color: statusColor(r.fulfillment) }}>
                                {pct(r.fulfillment)}
                              </span>
                              <div className="h-3 flex-1 rounded-full min-w-[70px] overflow-hidden" style={{ background: "#ddd8ee" }}>
                                <div className="h-full rounded-full" style={{ width: `${Math.min(100, r.fulfillment)}%`, background: statusColor(r.fulfillment) }} />
                              </div>
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-3.5 text-right font-extrabold">{r.rate === null ? "—" : pct(r.rate)}</td>
                        <td className="px-3 py-3.5 text-right whitespace-nowrap font-black text-[15px]">{r.bonus === null ? "—" : money(r.bonus)}</td>
                        <td className="px-3 py-3.5 text-right font-black" style={{ color: statusColor(r.forecastPct) }}>
                          {r.forecastPct === null ? "—" : pct(r.forecastPct)}
                        </td>
                        <td className="px-3 py-3.5 text-right whitespace-nowrap font-bold">{money(r.today)}</td>
                        <td className="px-3 py-3.5 text-right whitespace-nowrap font-bold">{money(r.week)}</td>
                        <td className="px-3 py-3.5 text-right font-extrabold">{trim2Ru(r.receipts)}</td>
                        <td className="px-3 py-3.5 text-right font-extrabold">{r.depth === null ? "—" : trim2Ru(r.depth)}</td>
                      </tr>
                    ))}
                    {d.rows.length === 0 && (
                      <tr>
                        <td colSpan={12} className="px-3 py-8 text-center font-extrabold" style={{ color: LABEL }}>
                          В этом месяце продаж пока нет.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {d.noSales.length > 0 && (
                <p className="text-xs font-extrabold mt-4" style={{ color: LABEL }}>
                  Нет продаж в этом месяце: {d.noSales.join(", ")}
                </p>
              )}
              <div className="text-xs font-bold mt-3 leading-relaxed" style={{ color: LABEL }}>
                <p>
                  <span className="font-black">Сегодня</span> — оборот за сегодняшний день. <span className="font-black">Неделя</span> — оборот с понедельника по сегодня. Оба с учётом возвратов.
                </p>
                <p>
                  <span className="font-black">Чеки</span> — сколько чеков пробито с начала месяца. <span className="font-black">Глубина чека</span> — сколько товаров в среднем в одном чеке за месяц.
                </p>
                <p>Бонус сейчас = оборот × ставка (выполнение 0–85% — 2%, 86–90% — 2,5%, 91–99% — 3%, от 100% — 4%).</p>
              </div>
            </div>
          </div>
        )}

        {!needLogin && !d && loading && (
          <p className="text-sm font-extrabold" style={{ color: LABEL }}>
            Загрузка…
          </p>
        )}
      </div>
    </div>
  );
}
