"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getErrorMessage } from "@/lib/errors";
import { ago, avatarClass, CheckBig, CloseIcon, CrossBig, dateRu, dayMonth, formatPhone, initials, kassaApi, LinkIcon, num, SearchIcon, tg, timeRu } from "./ui";

type ClientRow = {
  ms_id: string;
  name: string;
  phone: string;
  demands_count: number;
  demands_sum: number;
  last_demand_at: string | null;
  bonus_balance: number;
  bonus_available: number;
  bonus_waiting: number;
};

type Purchase = {
  kind: "sale" | "return";
  id: string;
  name: string;
  at: string;
  sum: number;
  city: string;
  earned: number;
  spent: number;
  activatesOn: string;
  lotState: "waiting" | "active" | "used" | "none" | "expired";
  link: string;
};

type Card = {
  client: { id: string; name: string; phone: string };
  bonus: { balance: number; available: number; waiting: number; nextActivation: string | null; expired: number };
  returning: boolean;
  purchases: Purchase[];
};

export default function ClientsTab() {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<ClientRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async (query: string) => {
    const my = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const res = await kassaApi<{ clients: ClientRow[]; total: number }>(`/api/kassa/clients?q=${encodeURIComponent(query)}`);
      if (my !== seq.current) return;
      setRows(res.clients);
      setTotal(res.total);
    } catch (e) {
      if (my === seq.current) setError(getErrorMessage(e));
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => load(q), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q, load]);

  return (
    <div className="mx-auto w-full max-w-5xl">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute left-5 top-1/2 h-6 w-6 -translate-y-1/2 text-muted" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Телефон или имя клиента"
          className="h-16 w-full rounded-2xl border border-border bg-surface pl-14 pr-14 text-xl font-semibold text-ink shadow-sm outline-none transition focus:border-accent focus:shadow-md focus:ring-4 focus:ring-[color-mix(in_srgb,var(--color-accent)_16%,transparent)]"
        />
        {q && (
          <button type="button" onClick={() => setQ("")} className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full p-2 text-muted hover:bg-borderSoft hover:text-ink" aria-label="Очистить">
            <CloseIcon className="h-5 w-5" />
          </button>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between px-1 text-[13px] text-muted">
        <span>{q ? `Найдено: ${num(total)}` : `Последние покупатели · всего клиентов ${num(total)}`}</span>
        {loading && <span className="animate-pulse">обновляю…</span>}
      </div>

      {error && <div className="mt-4 rounded-2xl border border-red-300/60 bg-red-50 px-5 py-4 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</div>}

      <div className="mt-3 flex flex-col gap-2.5">
        {rows.map((c) => (
          <button
            key={c.ms_id}
            type="button"
            onClick={() => setOpenId(c.ms_id)}
            className="group flex items-center gap-4 rounded-2xl border border-border bg-surface px-5 py-4 text-left shadow-[0_1px_0_rgba(0,0,0,0.02)] transition hover:-translate-y-px hover:border-accent hover:shadow-lg"
          >
            <div className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br ${avatarClass(c.name)} text-lg font-extrabold text-white shadow-md`}>{initials(c.name)}</div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-xl font-bold leading-tight text-ink">{c.name || "Без имени"}</div>
              <div className="mt-0.5 text-[17px] font-semibold tabular-nums tracking-wide text-muted">{formatPhone(c.phone)}</div>
            </div>
            <div className="hidden text-right sm:block">
              <div className="text-[12px] font-semibold uppercase tracking-wider text-mutedLight">Последняя покупка</div>
              <div className="text-[15px] font-bold text-ink">{ago(c.last_demand_at)}</div>
              <div className="text-[12.5px] text-muted">{c.last_demand_at ? dateRu(c.last_demand_at, true) : "—"}</div>
            </div>
            <div className="hidden text-right md:block">
              <div className="text-[12px] font-semibold uppercase tracking-wider text-mutedLight">Покупок на</div>
              <div className="text-[15px] font-bold text-ink">{tg(c.demands_sum)}</div>
              <div className="text-[12.5px] text-muted">{num(c.demands_count)} {c.demands_count === 1 ? "чек" : "чеков"}</div>
            </div>
            <div className="min-w-[116px] rounded-xl bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)] px-3.5 py-2 text-right">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-accent dark:text-emerald-300">Бонусы</div>
              <div className="text-xl font-extrabold tabular-nums text-ink">{tg(c.bonus_balance)}</div>
            </div>
          </button>
        ))}
        {!loading && rows.length === 0 && !error && (
          <div className="rounded-2xl border border-dashed border-border px-6 py-14 text-center text-lg text-muted">Клиент не найден. Проверьте номер телефона или имя.</div>
        )}
      </div>

      {openId && <ClientPanel id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function ClientPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const [card, setCard] = useState<Card | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCard(null);
    setError(null);
    kassaApi<Card>(`/api/kassa/client?id=${id}`)
      .then((c) => !cancelled && setCard(c))
      .catch((e) => !cancelled && setError(getErrorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <aside className="kassa-slide relative flex h-full w-full max-w-[640px] flex-col overflow-y-auto bg-paper shadow-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-[color-mix(in_srgb,var(--color-paper)_90%,transparent)] px-6 py-4 backdrop-blur">
          <div className="text-[13px] font-semibold uppercase tracking-widest text-muted">Карточка клиента</div>
          <button type="button" onClick={onClose} className="rounded-full bg-borderSoft p-2.5 text-ink hover:bg-border" aria-label="Закрыть">
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        {error && <div className="m-6 rounded-2xl border border-red-300/60 bg-red-50 px-5 py-4 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</div>}
        {!card && !error && <PanelSkeleton />}
        {card && <PanelBody card={card} />}
      </aside>
    </div>
  );
}

function PanelSkeleton() {
  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="h-8 w-2/3 animate-pulse rounded-xl bg-borderSoft" />
      <div className="h-6 w-1/3 animate-pulse rounded-xl bg-borderSoft" />
      <div className="h-52 animate-pulse rounded-3xl bg-borderSoft" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-24 animate-pulse rounded-2xl bg-borderSoft" />
      ))}
    </div>
  );
}

function PanelBody({ card }: { card: Card }) {
  const { bonus } = card;
  const can = bonus.available > 0;
  return (
    <div className="flex flex-col gap-6 p-6 pb-12">
      <div>
        <div className="text-[28px] font-extrabold leading-tight text-ink">{card.client.name || "Без имени"}</div>
        <div className="mt-1 text-[22px] font-bold tabular-nums tracking-wide text-muted">{formatPhone(card.client.phone)}</div>
      </div>

      {/* главный индикатор: зелёный круг — можно списывать, красный крест — списать пока нечего */}
      <div className={`relative overflow-hidden rounded-[28px] border p-6 ${can ? "border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 via-emerald-500/5 to-transparent" : "border-red-500/30 bg-gradient-to-br from-red-500/10 via-red-500/5 to-transparent"}`}>
        <div className="flex items-center gap-6">
          {can ? (
            <div className="kassa-pop flex h-40 w-40 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-emerald-400 to-emerald-600 text-white shadow-[0_18px_50px_-10px_rgba(16,185,129,0.65)] ring-[10px] ring-emerald-500/15">
              <CheckBig className="h-20 w-20" />
            </div>
          ) : (
            <div className="kassa-pop flex h-40 w-40 shrink-0 items-center justify-center text-red-500 drop-shadow-[0_10px_30px_rgba(239,68,68,0.45)]">
              <CrossBig className="h-36 w-36" />
            </div>
          )}
          <div className="min-w-0">
            <div className={`text-[13px] font-bold uppercase tracking-widest ${can ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300"}`}>
              {can ? "Можно списать сейчас" : "Списать пока нечего"}
            </div>
            <div className="mt-1 text-[44px] font-extrabold leading-none tabular-nums text-ink">{tg(bonus.available)}</div>
            <div className="mt-3 text-[15px] leading-snug text-muted">
              {bonus.waiting > 0 && bonus.nextActivation ? (
                <>
                  Ещё <b className="text-ink">{tg(bonus.waiting)}</b> откроются с <b className="text-ink">{dayMonth(bonus.nextActivation)}</b>
                </>
              ) : card.returning ? (
                "Ожидающих активации бонусов нет"
              ) : (
                "Первая покупка — бонусы откроются через 14 дней"
              )}
            </div>
            <div className="mt-1 text-[13px] text-mutedLight">Не больше 50% суммы чека</div>
          </div>
        </div>
        <div className="mt-5 grid grid-cols-3 gap-3 text-center">
          <Stat label="Всего бонусов" value={tg(bonus.balance)} />
          <Stat label="Доступно" value={tg(bonus.available)} />
          <Stat label="Ждут активации" value={tg(bonus.waiting)} />
        </div>
        {bonus.expired > 0 && (
          <div className="mt-3 rounded-xl bg-amber-500/15 px-4 py-2.5 text-[13.5px] font-semibold text-amber-800 dark:text-amber-300">
            Бонусы на {tg(bonus.expired)} сгорели (прошло 4 месяца) — не списываются.
          </div>
        )}
      </div>

      <div>
        <div className="mb-3 flex items-baseline justify-between">
          <div className="text-[13px] font-bold uppercase tracking-widest text-muted">История покупок</div>
          <div className="text-[13px] text-mutedLight">{card.purchases.length}</div>
        </div>
        <div className="flex flex-col gap-2.5">
          {card.purchases.length === 0 && <div className="rounded-2xl border border-dashed border-border px-5 py-8 text-center text-muted">Покупок пока нет</div>}
          {card.purchases.map((p) => (
            <a
              key={`${p.kind}-${p.id}`}
              href={p.link}
              target="_blank"
              rel="noreferrer"
              className="group block rounded-2xl border border-border bg-surface px-5 py-4 transition hover:border-accent hover:shadow-md"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-[17px] font-bold text-ink">
                    {p.kind === "return" ? "Возврат" : "Чек"} №{p.name}
                    <LinkIcon className="h-4 w-4 text-mutedLight transition group-hover:text-accent" />
                  </div>
                  <div className="mt-0.5 text-[13.5px] text-muted">
                    {dateRu(p.at, true)}, {timeRu(p.at)}
                    {p.city ? ` · ${p.city}` : ""}
                  </div>
                </div>
                <div className={`text-[22px] font-extrabold tabular-nums ${p.kind === "return" ? "text-red-600 dark:text-red-400" : "text-ink"}`}>{p.kind === "return" ? `−${tg(Math.abs(p.sum))}` : tg(p.sum)}</div>
              </div>
              {p.kind === "sale" && (
                <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px] font-semibold">
                  {p.earned > 0 && <span className="rounded-lg bg-emerald-500/12 px-2.5 py-1 text-emerald-700 dark:text-emerald-300">+{num(p.earned)} бонусов</span>}
                  {p.spent > 0 && <span className="rounded-lg bg-sky-500/12 px-2.5 py-1 text-sky-700 dark:text-sky-300">−{num(p.spent)} оплачено бонусами</span>}
                  {p.lotState === "waiting" && <span className="rounded-lg bg-amber-500/15 px-2.5 py-1 text-amber-800 dark:text-amber-300">бонусы откроются {dayMonth(p.activatesOn)}</span>}
                  {p.lotState === "active" && <span className="rounded-lg bg-emerald-500/12 px-2.5 py-1 text-emerald-700 dark:text-emerald-300">бонусы активны</span>}
                  {p.lotState === "used" && p.earned > 0 && <span className="rounded-lg bg-borderSoft px-2.5 py-1 text-muted">бонусы использованы</span>}
                  {p.lotState === "expired" && <span className="rounded-lg bg-red-500/12 px-2.5 py-1 text-red-700 dark:text-red-300">бонусы сгорели</span>}
                </div>
              )}
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-surface/70 px-3 py-3 ring-1 ring-border backdrop-blur">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-mutedLight">{label}</div>
      <div className="mt-1 text-[18px] font-extrabold tabular-nums text-ink">{value}</div>
    </div>
  );
}
