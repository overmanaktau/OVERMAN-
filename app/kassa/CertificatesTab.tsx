"use client";

import { useEffect, useState } from "react";
import { getErrorMessage } from "@/lib/errors";
import { CheckBig, CloseIcon, dateRu, kassaApi, TicketIcon, tg } from "./ui";

// Сертификаты на кассе — как у консультанта в Telegram: продать, использовать (привязка к чеку со сверкой
// способа оплаты), вернуть. Неактивный сертификат (использован, возвращён, срок истёк) — «не найден».

type Cert = { id: number; number: string; amount: number; pay: string; payCash: number; payNoncash: number; seller: string; client: string; expiresAt: string };
type Check = { id: string; name: string; time: string; cashier: string; sum: number; cash: number; noncash: number; linked: boolean };
type Verify = { ok: boolean; problems: string[]; burned: number; demand: { id: string; name: string; sum: number; cash: number; noncash: number; cashier: string; time: string } };
type Mode = "home" | "use" | "return" | "sell";

const btnPrimary = "h-14 rounded-2xl bg-accent px-8 text-lg font-bold text-white shadow-md transition hover:brightness-110 active:scale-[0.98] disabled:opacity-50";
const btnGhost = "h-14 rounded-2xl border border-border bg-surface px-7 text-lg font-bold text-ink transition hover:border-accent active:scale-[0.98]";
const inputCls = "h-14 w-full rounded-2xl border border-border bg-surface px-5 text-lg font-semibold text-ink outline-none transition focus:border-accent focus:ring-4 focus:ring-[color-mix(in_srgb,var(--color-accent)_16%,transparent)]";

export default function CertificatesTab({ store }: { store: string }) {
  const [mode, setMode] = useState<Mode>("home");
  const reset = () => setMode("home");
  return (
    <div className="mx-auto w-full max-w-3xl">
      {mode === "home" && <Home onPick={setMode} />}
      {mode === "use" && <UseFlow store={store} onBack={reset} />}
      {mode === "return" && <ReturnFlow store={store} onBack={reset} />}
      {mode === "sell" && <SellFlow store={store} onBack={reset} />}
    </div>
  );
}

function Home({ onPick }: { onPick: (m: Mode) => void }) {
  const tiles: { mode: Mode; title: string; hint: string; tone: string }[] = [
    { mode: "use", title: "Использовать", hint: "Ввести номер и выбрать чек", tone: "from-emerald-500 to-teal-600" },
    { mode: "sell", title: "Продать", hint: "Оформить новый сертификат", tone: "from-sky-500 to-indigo-600" },
    { mode: "return", title: "Возврат", hint: "Вернуть неиспользованный", tone: "from-amber-500 to-orange-600" },
  ];
  return (
    <div className="kassa-fade grid gap-4 sm:grid-cols-3">
      {tiles.map((t) => (
        <button
          key={t.mode}
          type="button"
          onClick={() => onPick(t.mode)}
          className="group flex min-h-[210px] flex-col justify-between rounded-3xl border border-border bg-surface p-6 text-left shadow-sm transition hover:-translate-y-1 hover:border-accent hover:shadow-xl"
        >
          <div className={`flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br ${t.tone} text-white shadow-lg`}>
            <TicketIcon className="h-9 w-9" />
          </div>
          <div>
            <div className="text-2xl font-extrabold text-ink">{t.title}</div>
            <div className="mt-1 text-[15px] text-muted">{t.hint}</div>
          </div>
        </button>
      ))}
    </div>
  );
}

function Shell({ title, onBack, children }: { title: string; onBack: () => void; children: React.ReactNode }) {
  return (
    <div className="kassa-fade rounded-3xl border border-border bg-surface p-7 shadow-sm">
      <div className="mb-6 flex items-center justify-between">
        <div className="text-2xl font-extrabold text-ink">{title}</div>
        <button type="button" onClick={onBack} className="rounded-full bg-borderSoft p-2.5 text-ink hover:bg-border" aria-label="Назад">
          <CloseIcon className="h-5 w-5" />
        </button>
      </div>
      {children}
    </div>
  );
}

function ErrorBox({ text }: { text: string }) {
  return <div className="rounded-2xl border border-red-300/60 bg-red-50 px-5 py-4 text-[15px] font-semibold text-red-700 dark:bg-red-950/40 dark:text-red-300">{text}</div>;
}

function CertCard({ c }: { c: Cert }) {
  return (
    <div className="rounded-2xl bg-gradient-to-br from-emerald-500/12 to-teal-500/5 p-5 ring-1 ring-emerald-500/25">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[12px] font-bold uppercase tracking-widest text-emerald-700 dark:text-emerald-300">Сертификат</div>
          <div className="text-3xl font-extrabold text-ink">№{c.number}</div>
        </div>
        <div className="text-right">
          <div className="text-3xl font-extrabold tabular-nums text-ink">{tg(c.amount)}</div>
          <div className="text-[14px] text-muted">{c.pay}</div>
        </div>
      </div>
      <div className="mt-3 text-[14px] text-muted">
        Продал {c.seller} · клиент {c.client} · действует до {dateRu(c.expiresAt, true)}
      </div>
    </div>
  );
}

// Ввод номера → поиск; найден — продолжаем, нет — «не найден».
function NumberStep({ store, label, onFound }: { store: string; label: string; onFound: (c: Cert) => void }) {
  const [number, setNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function find() {
    if (!number.trim() || busy) return;
    setBusy(true);
    setError(null);
    setNotFound(false);
    try {
      const res = await kassaApi<{ found: boolean; cert?: Cert }>(`/api/kassa/certificates?store=${store}&number=${encodeURIComponent(number.trim())}`);
      if (res.found && res.cert) onFound(res.cert);
      else setNotFound(true);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-4">
      <label className="text-[13px] font-bold uppercase tracking-widest text-muted">{label}</label>
      <input autoFocus value={number} onChange={(e) => setNumber(e.target.value)} onKeyDown={(e) => e.key === "Enter" && find()} placeholder="Номер сертификата" className={inputCls + " text-2xl"} />
      {notFound && <ErrorBox text={`Сертификат «${number.trim()}» не найден.`} />}
      {error && <ErrorBox text={error} />}
      <button type="button" disabled={busy || !number.trim()} onClick={find} className={btnPrimary}>
        {busy ? "Ищу…" : "Найти"}
      </button>
    </div>
  );
}

function Done({ text, sub, onBack }: { text: string; sub?: string; onBack: () => void }) {
  return (
    <div className="kassa-fade flex flex-col items-center gap-5 py-6 text-center">
      <div className="kassa-pop flex h-32 w-32 items-center justify-center rounded-full bg-gradient-to-br from-emerald-400 to-emerald-600 text-white shadow-[0_18px_50px_-10px_rgba(16,185,129,0.6)]">
        <CheckBig className="h-16 w-16" />
      </div>
      <div className="text-3xl font-extrabold text-ink">{text}</div>
      {sub && <div className="text-lg text-muted">{sub}</div>}
      <button type="button" onClick={onBack} className={btnPrimary}>
        Готово
      </button>
    </div>
  );
}

function UseFlow({ store, onBack }: { store: string; onBack: () => void }) {
  const [cert, setCert] = useState<Cert | null>(null);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [verify, setVerify] = useState<Verify | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function loadChecks() {
    setBusy(true);
    setError(null);
    try {
      setChecks((await kassaApi<{ checks: Check[] }>(`/api/kassa/certificates?store=${store}&checks=1`)).checks);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function pick(check: Check) {
    if (!cert) return;
    setBusy(true);
    setError(null);
    try {
      const v = await kassaApi<Verify | { error: string }>("/api/kassa/certificates", { method: "POST", body: { store, action: "verify", certId: cert.id, demandId: check.id } });
      if ("error" in v) throw new Error(v.error);
      setVerify(v);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function act(action: "use" | "request") {
    if (!cert || !verify) return;
    setBusy(true);
    setError(null);
    try {
      await kassaApi("/api/kassa/certificates", { method: "POST", body: { store, action, certId: cert.id, demandId: verify.demand.id } });
      setDone(action === "use" ? `Сертификат №${cert.number} использован` : "Запрос отправлен руководителю");
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (done) return <Shell title="Использование сертификата" onBack={onBack}><Done text={done} sub={verify ? `Чек №${verify.demand.name}` : undefined} onBack={onBack} /></Shell>;

  return (
    <Shell title="Использование сертификата" onBack={onBack}>
      {!cert && <NumberStep store={store} label="Какой сертификат используем?" onFound={(c) => { setCert(c); loadChecks(); }} />}
      {cert && !verify && (
        <div className="flex flex-col gap-5">
          <CertCard c={cert} />
          <div className="text-[13px] font-bold uppercase tracking-widest text-muted">На какой чек использовать?</div>
          {error && <ErrorBox text={error} />}
          {!checks && <div className="h-24 animate-pulse rounded-2xl bg-borderSoft" />}
          <div className="flex max-h-[46vh] flex-col gap-2.5 overflow-y-auto pr-1">
            {checks?.length === 0 && <div className="rounded-2xl border border-dashed border-border px-5 py-8 text-center text-muted">Чеков за сегодня пока нет</div>}
            {checks?.map((c) => (
              <button
                key={c.id}
                type="button"
                disabled={busy}
                onClick={() => pick(c)}
                className="flex items-center justify-between gap-4 rounded-2xl border border-border bg-surface px-5 py-4 text-left transition hover:border-accent hover:shadow-md disabled:opacity-60"
              >
                <div>
                  <div className="text-lg font-bold text-ink">
                    {c.linked && <TicketIcon className="mr-1.5 inline h-5 w-5 text-emerald-600 dark:text-emerald-300" />}№{c.name} · {c.time}
                  </div>
                  <div className="text-[14px] text-muted">{c.cashier}</div>
                </div>
                <div className="text-right">
                  <div className="text-xl font-extrabold tabular-nums text-ink">{tg(c.sum)}</div>
                  <div className="text-[13px] text-muted">нал {tg(c.cash)} · безнал {tg(c.noncash)}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
      {cert && verify && (
        <div className="flex flex-col gap-5">
          <CertCard c={cert} />
          <div className="rounded-2xl border border-border p-5">
            <div className="text-[13px] font-bold uppercase tracking-widest text-muted">Выбранный чек</div>
            <div className="mt-1 flex items-center justify-between">
              <div className="text-xl font-bold text-ink">№{verify.demand.name} · {verify.demand.time} · {verify.demand.cashier}</div>
              <div className="text-xl font-extrabold tabular-nums text-ink">{tg(verify.demand.sum)}</div>
            </div>
            <div className="text-[14px] text-muted">нал {tg(verify.demand.cash)} · безнал {tg(verify.demand.noncash)}</div>
          </div>
          {verify.ok ? (
            <>
              {verify.burned > 0 && <div className="rounded-2xl bg-amber-500/15 px-5 py-3 text-[15px] font-semibold text-amber-800 dark:text-amber-300">Чек меньше номинала — остаток {tg(verify.burned)} сгорит.</div>}
              {error && <ErrorBox text={error} />}
              <div className="flex gap-3">
                <button type="button" disabled={busy} onClick={() => act("use")} className={btnPrimary + " flex-1"}>
                  {busy ? "Оформляю…" : "Использовать"}
                </button>
                <button type="button" onClick={() => setVerify(null)} className={btnGhost}>Другой чек</button>
              </div>
            </>
          ) : (
            <>
              <ErrorBox text={`Способ оплаты чека не совпадает с сертификатом:\n${verify.problems.map((p) => `• ${p}`).join("\n")}`} />
              {error && <ErrorBox text={error} />}
              <div className="flex flex-col gap-3 sm:flex-row">
                <button type="button" onClick={() => setVerify(null)} className={btnPrimary + " flex-1"}>Выбрать другой чек</button>
                <button type="button" disabled={busy} onClick={() => act("request")} className={btnGhost + " flex-1"}>Нужен именно этот — запрос руководителю</button>
              </div>
            </>
          )}
        </div>
      )}
    </Shell>
  );
}

function ReturnFlow({ store, onBack }: { store: string; onBack: () => void }) {
  const [cert, setCert] = useState<Cert | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    if (!cert) return;
    setBusy(true);
    setError(null);
    try {
      await kassaApi("/api/kassa/certificates", { method: "POST", body: { store, action: "return", certId: cert.id } });
      setDone(true);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  if (done && cert) return <Shell title="Возврат сертификата" onBack={onBack}><Done text={`Возврат №${cert.number} оформлен`} sub="Использовать этот сертификат больше нельзя" onBack={onBack} /></Shell>;
  return (
    <Shell title="Возврат сертификата" onBack={onBack}>
      {!cert && <NumberStep store={store} label="Какой сертификат возвращают?" onFound={setCert} />}
      {cert && (
        <div className="flex flex-col gap-5">
          <CertCard c={cert} />
          <div className="text-lg text-muted">Точно вернуть? После возврата использовать сертификат будет нельзя.</div>
          {error && <ErrorBox text={error} />}
          <div className="flex gap-3">
            <button type="button" disabled={busy} onClick={confirm} className={btnPrimary + " flex-1"}>{busy ? "Оформляю…" : "Да, вернуть"}</button>
            <button type="button" onClick={onBack} className={btnGhost}>Нет</button>
          </div>
        </div>
      )}
    </Shell>
  );
}

function SellFlow({ store, onBack }: { store: string; onBack: () => void }) {
  const [sellers, setSellers] = useState<{ id: string; name: string }[] | null>(null);
  const [sellerId, setSellerId] = useState("");
  const [amount, setAmount] = useState("");
  const [pay, setPay] = useState<"cash" | "noncash" | "mixed">("cash");
  const [cash, setCash] = useState("");
  const [noncash, setNoncash] = useState("");
  const [client, setClient] = useState("");
  const [phone, setPhone] = useState("");
  const [number, setNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ number: string; expiresAt: string } | null>(null);

  useEffect(() => {
    kassaApi<{ sellers: { id: string; name: string }[] }>(`/api/kassa/certificates?store=${store}&sellers=1`)
      .then((r) => setSellers(r.sellers))
      .catch((e) => setError(getErrorMessage(e)));
  }, [store]);

  async function submit() {
    setBusy(true);
    setError(null);
    const total = Number(String(amount).replace(/\s/g, "")) || 0;
    const body = {
      store,
      action: "sell",
      sellerId,
      amount: total,
      cash: pay === "cash" ? total : pay === "noncash" ? 0 : Number(cash) || 0,
      noncash: pay === "noncash" ? total : pay === "cash" ? 0 : Number(noncash) || 0,
      client,
      phone,
      number,
    };
    try {
      const r = await kassaApi<{ number: string; expiresAt: string }>("/api/kassa/certificates", { method: "POST", body });
      setDone(r);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (done) return <Shell title="Продажа сертификата" onBack={onBack}><Done text={`Сертификат №${done.number} продан`} sub={`Действует до ${dateRu(done.expiresAt, true)}`} onBack={onBack} /></Shell>;
  return (
    <Shell title="Продажа сертификата" onBack={onBack}>
      <div className="flex flex-col gap-4">
        <Field label="Кто продаёт">
          <select value={sellerId} onChange={(e) => setSellerId(e.target.value)} className={inputCls}>
            <option value="">Выберите сотрудника</option>
            {sellers?.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Сумма сертификата, ₸">
          <input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="10 000" className={inputCls} />
        </Field>
        <Field label="Как оплачен">
          <div className="grid grid-cols-3 gap-2">
            {([["cash", "Наличные"], ["noncash", "Безнал"], ["mixed", "Смешанная"]] as const).map(([k, l]) => (
              <button key={k} type="button" onClick={() => setPay(k)} className={`h-14 rounded-2xl border text-lg font-bold transition ${pay === k ? "border-accent bg-accent text-white shadow-md" : "border-border bg-surface text-ink hover:border-accent"}`}>
                {l}
              </button>
            ))}
          </div>
        </Field>
        {pay === "mixed" && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Наличными, ₸"><input inputMode="numeric" value={cash} onChange={(e) => setCash(e.target.value)} className={inputCls} /></Field>
            <Field label="Безналом, ₸"><input inputMode="numeric" value={noncash} onChange={(e) => setNoncash(e.target.value)} className={inputCls} /></Field>
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Имя клиента"><input value={client} onChange={(e) => setClient(e.target.value)} className={inputCls} /></Field>
          <Field label="Телефон клиента"><input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="8 701 123 45 67" className={inputCls} /></Field>
        </div>
        <Field label="Номер сертификата"><input value={number} onChange={(e) => setNumber(e.target.value)} className={inputCls} /></Field>
        {error && <ErrorBox text={error} />}
        <button type="button" disabled={busy || !sellerId || !amount || !client || !phone || !number} onClick={submit} className={btnPrimary}>
          {busy ? "Оформляю…" : "Продать сертификат"}
        </button>
      </div>
    </Shell>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[12.5px] font-bold uppercase tracking-widest text-muted">{label}</label>
      {children}
    </div>
  );
}
