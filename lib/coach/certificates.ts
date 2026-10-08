// Подарочные сертификаты в боте-помощнике. По кассе сертификат не пробивается, поэтому учёт ручной:
//  • консультант: «Сертификат» → продать / использовать (с привязкой к чеку МойСклад) / вернуть;
//  • администраторы и владельцы: «Сертификаты» → проданные / использованные / не использованные по периодам;
//  • при использовании способ оплаты сертификата сверяется со способом оплаты чека; если не совпал —
//    выбрать другой чек или запрос главному владельцу («Отказать» / «Проверить чек ещё раз»);
//  • ночью проверяется, не было ли возврата по чеку, к которому привязан сертификат.
// Деньги — в тенге (в МойСклад копейки, их переводит lib/moysklad). В отчёты сертификаты пока не входят.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { escapeHtml } from "@/lib/telegram";
import { fetchActiveEmployees, fetchCheckById, fetchChecksForDate, type CheckInfo } from "@/lib/moysklad";
import { REGISTER_STORE } from "@/lib/registers";
import { money } from "@/lib/reports/sales";
import { addDays, mondayOf, monthStartOf, todayInAlmaty } from "@/lib/coach/metrics";
import { menuFor, type ReplyMarkup, type Transport } from "@/lib/coach/bot";

export type CertUser = {
  id: number;
  telegram_chat_id: number;
  store: string;
  employee_ms_id: string;
  employee_name: string;
  is_admin: boolean;
  admin_scope: "city" | "all";
  is_protected: boolean;
  is_test: boolean;
};

type Status = "active" | "pending_use" | "used" | "returned";
type Cert = {
  id: number;
  store: string;
  number: string;
  amount: number;
  pay_cash: number;
  pay_noncash: number;
  client_name: string;
  client_phone: string;
  seller_ms_id: string;
  seller_name: string;
  created_by: number | null;
  sold_at: string;
  expires_at: string;
  status: Status;
  use_demand_id: string | null;
  use_demand_name: string | null;
  use_demand_moment: string | null;
  use_demand_sum: number | null;
  use_demand_cash: number | null;
  use_demand_noncash: number | null;
  use_demand_cashier: string | null;
  use_requested_by: number | null;
  use_requested_at: string | null;
  use_problem: string | null;
  used_at: string | null;
  returned_at: string | null;
  returned_by: string | null;
  demand_return_noticed_at: string | null;
  demand_return_sum: number;
  demand_return_last_date: string | null;
  demand_return_decision: "kept" | "restored" | null;
};

const CITY: Record<string, string> = { point_1: "Актау", point_3: "Актобе" };
const HIDDEN_NAME = /саяпарк|saya/i;
const EXPIRY_MONTHS = 3;
const CHECKS_PER_PAGE = 8;
const MAX_AMOUNT = 10_000_000;
const TOLERANCE = 1; // тенге — на округление

// ───────── вспомогательное ─────────

const mdLink = (id: string) => `https://online.moysklad.ru/app/#retaildemand/edit?id=${id}`;

function cityName(store: string): string {
  return CITY[store] ?? store;
}

function fmtDate(iso: string): string {
  return new Intl.DateTimeFormat("ru-RU", { timeZone: "Asia/Almaty", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(iso));
}

// «2026-10-08 14:32:00.000» (время МойСклад, на 2 часа раньше Алматы) → «16:32».
function almatyTime(moment: string): string {
  const h = (Number(moment.slice(11, 13)) + 2) % 24;
  return `${String(h).padStart(2, "0")}:${moment.slice(14, 16)}`;
}

// Торговый день: после полуночи магазин ещё закрывается, поэтому до 04:00 «сегодня» — вчерашний день.
function businessDate(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Almaty" }).format(new Date(Date.now() - 4 * 3600 * 1000));
}

export function parseAmount(text: string): number | null {
  const m = text.replace(/[\s ,]/g, "").match(/^(\d+)([кk])?$/i);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] ? 1000 : 1);
  return Number.isFinite(n) && n >= 1 && n <= MAX_AMOUNT ? n : null;
}

export function normalizePhone(text: string): string | null {
  let d = text.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("8")) d = `7${d.slice(1)}`;
  else if (d.length === 10) d = `7${d}`;
  if (d.length < 11 || d.length > 13) return null;
  return `+${d}`;
}

function fmtPhone(p: string): string {
  const m = p.match(/^\+7(\d{3})(\d{3})(\d{2})(\d{2})$/);
  return m ? `+7 ${m[1]} ${m[2]} ${m[3]} ${m[4]}` : p;
}

function payText(c: { pay_cash: number; pay_noncash: number }): string {
  if (c.pay_noncash === 0) return "наличные";
  if (c.pay_cash === 0) return "безнал";
  return `смешанная (нал ${money(c.pay_cash)}, безнал ${money(c.pay_noncash)})`;
}

function addMonthsIso(from: Date, months: number): string {
  const d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString();
}

const isExpired = (c: Pick<Cert, "expires_at">) => new Date(c.expires_at).getTime() < Date.now();

async function logEvent(certificateId: number, actor: string, action: string, note?: string) {
  const { error } = await supabaseAdmin.from("certificate_events").insert({ certificate_id: certificateId, actor, action, note: note ?? null });
  if (error) console.error("certificate_events:", error.message);
}

// ───────── диалог (черновик) ─────────

type Draft = { step: string; data: Record<string, unknown> };

async function getDraft(userId: number): Promise<Draft | null> {
  const { data, error } = await supabaseAdmin.from("certificate_drafts").select("step, data").eq("coach_user_id", userId).maybeSingle();
  if (error) throw error;
  return (data as Draft | null) ?? null;
}

async function saveDraft(userId: number, step: string, data: Record<string, unknown>, awaitText: boolean) {
  const { error } = await supabaseAdmin
    .from("certificate_drafts")
    .upsert({ coach_user_id: userId, step, data, updated_at: new Date().toISOString() });
  if (error) throw error;
  const { error: e2 } = await supabaseAdmin.from("coach_users").update({ awaiting: awaitText ? "cert" : null }).eq("id", userId);
  if (e2) throw e2;
}

export async function clearCertDraft(userId: number) {
  await supabaseAdmin.from("certificate_drafts").delete().eq("coach_user_id", userId);
  await supabaseAdmin.from("coach_users").update({ awaiting: null }).eq("id", userId).eq("awaiting", "cert");
}

const CANCEL_ROW = [{ text: "✖️ Отмена", callback_data: "cs:x" }];
const cancelMarkup: ReplyMarkup = { inline_keyboard: [CANCEL_ROW] };

// ───────── меню консультанта ─────────

export async function sendConsultantMenu(t: Transport, user: CertUser) {
  await clearCertDraft(user.id);
  await t.send(user.telegram_chat_id, "🎟 <b>Сертификат</b>\nЧто сделать?", {
    inline_keyboard: [
      [{ text: "💳 Продать", callback_data: "cs:sell" }],
      [{ text: "✅ Использовать", callback_data: "cs:use" }],
      [{ text: "↩️ Возврат", callback_data: "cs:ret" }],
    ],
  });
}

// Кого предложить как продавца: активные сотрудники МойСклад этого города (продавали за 60 дней) и
// подтверждённые консультанты города. Если МойСклад не ответил — ошибка, а не список «на всякий случай».
async function citySellers(store: string): Promise<{ id: string; name: string }[]> {
  const since = addDays(todayInAlmaty(), -60);
  const rows: { employee_ms_id: string; employee_name: string }[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabaseAdmin
      .from("moysklad_employee_sales_daily")
      .select("employee_ms_id, employee_name")
      .eq("store", store)
      .gte("sale_date", since)
      .order("sale_date", { ascending: false })
      .order("employee_ms_id")
      .range(offset, offset + 999);
    if (error) throw error;
    rows.push(...((data ?? []) as typeof rows));
    if (!data || data.length < 1000) break;
  }
  const registered = await supabaseAdmin
    .from("coach_users")
    .select("employee_ms_id, employee_name")
    .eq("store", store)
    .eq("status", "approved")
    .eq("is_test", false)
    .eq("is_admin", false);
  if (registered.error) throw registered.error;
  const active = await fetchActiveEmployees();
  const activeIds = new Set(active.map((e) => e.id));
  const byId = new Map<string, string>();
  for (const r of [...rows, ...((registered.data ?? []) as typeof rows)]) {
    if (!activeIds.has(r.employee_ms_id) || HIDDEN_NAME.test(r.employee_name) || byId.has(r.employee_ms_id)) continue;
    byId.set(r.employee_ms_id, r.employee_name);
  }
  return [...byId.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "ru"));
}

// ───────── продажа ─────────

async function startSell(t: Transport, user: CertUser) {
  let sellers: { id: string; name: string }[];
  try {
    sellers = await citySellers(user.store);
  } catch {
    await t.send(user.telegram_chat_id, "Не удалось получить список сотрудников из МойСклад. Попробуйте ещё раз через минуту.");
    return;
  }
  if (sellers.length === 0) {
    await t.send(user.telegram_chat_id, "Не нашёл сотрудников вашего города. Обратитесь к руководителю.");
    return;
  }
  await saveDraft(user.id, "seller", {}, false);
  await t.send(user.telegram_chat_id, "💳 <b>Продажа сертификата</b>\nКто продаёт сертификат?", {
    inline_keyboard: [...sellers.slice(0, 60).map((s) => [{ text: s.name, callback_data: `cs:se:${s.id}` }]), CANCEL_ROW],
  });
}

const PAY_MARKUP: ReplyMarkup = {
  inline_keyboard: [
    [{ text: "💵 Наличные", callback_data: "cs:pm:c" }, { text: "💳 Безнал", callback_data: "cs:pm:n" }],
    [{ text: "Смешанная", callback_data: "cs:pm:m" }],
    CANCEL_ROW,
  ],
};

async function askClientName(t: Transport, user: CertUser, draft: Draft) {
  await saveDraft(user.id, "client", draft.data, true);
  await t.send(user.telegram_chat_id, "Имя клиента:", cancelMarkup);
}

function sellSummary(d: Record<string, unknown>, store: string): string {
  const amount = Number(d.amount);
  const pay = { pay_cash: Number(d.cash), pay_noncash: Number(d.noncash) };
  return [
    "<b>Проверьте данные сертификата</b>",
    `Номер: <b>${escapeHtml(String(d.number))}</b>`,
    `Номинал: <b>${money(amount)}</b>`,
    `Оплата: ${payText(pay)}`,
    `Продаёт: ${escapeHtml(String(d.seller_name))}`,
    `Клиент: ${escapeHtml(String(d.client))}, ${escapeHtml(fmtPhone(String(d.phone)))}`,
    `Город: ${cityName(store)}`,
  ].join("\n");
}

// Ответ на текст, пока идёт диалог. true — текст принадлежал диалогу.
export async function handleCertText(t: Transport, user: CertUser, text: string): Promise<boolean> {
  const draft = await getDraft(user.id);
  const chat = user.telegram_chat_id;
  if (!draft) {
    await clearCertDraft(user.id);
    return false;
  }
  const d = draft.data;
  const retry = async (msg: string) => {
    await t.send(chat, msg, cancelMarkup);
    return true;
  };

  if (draft.step === "amount") {
    const amount = parseAmount(text);
    if (!amount) return retry("Не понял сумму. Напишите число в тенге, например <b>10000</b>.");
    await saveDraft(user.id, "pay", { ...d, amount }, false);
    await t.send(chat, `Номинал: <b>${money(amount)}</b>. Как оплачен сертификат?`, PAY_MARKUP);
    return true;
  }
  if (draft.step === "mixed_non") {
    const amount = Number(d.amount);
    const non = parseAmount(text);
    if (!non || non >= amount) return retry(`Сумма безнала должна быть меньше номинала (${money(amount)}). Напишите число.`);
    await saveDraft(user.id, "mixed_cash", { ...d, noncash: non }, true);
    await t.send(chat, "Сколько оплачено наличными?", cancelMarkup);
    return true;
  }
  if (draft.step === "mixed_cash") {
    const amount = Number(d.amount);
    const non = Number(d.noncash);
    const cash = parseAmount(text);
    if (!cash) return retry("Не понял сумму. Напишите число в тенге.");
    if (cash + non !== amount) {
      await saveDraft(user.id, "mixed_non", { ...d, noncash: undefined }, true);
      await t.send(chat, `Не сходится: безнал ${money(non)} + наличные ${money(cash)} = ${money(non + cash)}, а номинал ${money(amount)}. Введите заново — сколько оплачено <b>безналом</b>?`, cancelMarkup);
      return true;
    }
    await askClientName(t, user, { step: "client", data: { ...d, cash } });
    return true;
  }
  if (draft.step === "client") {
    const name = text.trim().replace(/\s+/g, " ");
    if (name.length < 2 || name.length > 80) return retry("Напишите имя клиента.");
    await saveDraft(user.id, "phone", { ...d, client: name }, true);
    await t.send(chat, "Номер телефона клиента:", cancelMarkup);
    return true;
  }
  if (draft.step === "phone") {
    const phone = normalizePhone(text);
    if (!phone) return retry("Не понял номер. Напишите телефон, например <b>8 701 123 45 67</b>.");
    await saveDraft(user.id, "number", { ...d, phone }, true);
    await t.send(chat, "Номер сертификата (как напечатан на нём):", cancelMarkup);
    return true;
  }
  if (draft.step === "number") {
    const number = text.trim().replace(/\s+/g, " ");
    if (number.length < 1 || number.length > 32) return retry("Номер должен быть не длиннее 32 символов. Напишите номер сертификата.");
    const { data: dup, error } = await supabaseAdmin.from("certificates").select("id").ilike("number", number.replace(/[\\%_]/g, "\\$&")).limit(1);
    if (error) throw error;
    if (dup && dup.length > 0) return retry(`Сертификат с номером <b>${escapeHtml(number)}</b> уже есть в системе. Проверьте номер и напишите ещё раз.`);
    const data = { ...d, number };
    await saveDraft(user.id, "confirm_sell", data, false);
    await t.send(chat, `${sellSummary(data, user.store)}\n\nПродать?`, {
      inline_keyboard: [[{ text: "✅ Да, продать", callback_data: "cs:sy" }, { text: "Нет", callback_data: "cs:x" }]],
    });
    return true;
  }
  if (draft.step === "usenumber" || draft.step === "returnnumber") {
    const forReturn = draft.step === "returnnumber";
    const cert = await findCertByNumber(user.store, text);
    if (!cert) return retry(`Сертификат с номером <b>${escapeHtml(text.trim())}</b> в вашем городе не найден. Проверьте номер и напишите ещё раз.`);
    const why = unusableReason(cert, forReturn);
    if (why) {
      await clearCertDraft(user.id);
      await t.send(chat, `Сертификат №<b>${escapeHtml(cert.number)}</b> ${why}.`, menuFor(user));
      return true;
    }
    if (forReturn) {
      await saveDraft(user.id, "confirm_return", { certId: cert.id }, false);
      await t.send(chat, `Точно вернуть сертификат №<b>${escapeHtml(cert.number)}</b> на ${money(cert.amount)} (продал ${escapeHtml(cert.seller_name)})? После возврата использовать его будет нельзя.`, {
        inline_keyboard: [[{ text: "✅ Да, вернуть", callback_data: `cs:ry:${cert.id}` }, { text: "Нет", callback_data: "cs:x" }]],
      });
    } else {
      await showChecks(t, user, cert.id, 0);
    }
    return true;
  }
  // На других шагах ответ даётся кнопками — текст игнорируем.
  await t.send(chat, "Выберите вариант кнопкой выше или нажмите «Отмена».", cancelMarkup);
  return true;
}

async function finishSell(t: Transport, user: CertUser) {
  const chat = user.telegram_chat_id;
  const draft = await getDraft(user.id);
  if (!draft || draft.step !== "confirm_sell") {
    await t.send(chat, "Продажа уже оформлена или отменена.", menuFor(user));
    return;
  }
  const d = draft.data;
  const now = new Date();
  const { data, error } = await supabaseAdmin
    .from("certificates")
    .insert({
      store: user.store,
      number: String(d.number),
      amount: Number(d.amount),
      pay_cash: Number(d.cash),
      pay_noncash: Number(d.noncash),
      client_name: String(d.client),
      client_phone: String(d.phone),
      seller_ms_id: String(d.seller_id),
      seller_name: String(d.seller_name),
      created_by: user.id,
      sold_at: now.toISOString(),
      expires_at: addMonthsIso(now, EXPIRY_MONTHS),
      status: "active",
    })
    .select("id")
    .single();
  if (error) {
    await clearCertDraft(user.id);
    const dup = error.code === "23505";
    await t.send(chat, dup ? `Сертификат с номером <b>${escapeHtml(String(d.number))}</b> уже есть в системе — продажа не оформлена.` : "Не удалось сохранить сертификат. Попробуйте ещё раз.", menuFor(user));
    return;
  }
  await logEvent(data.id, user.employee_name, "sold", `${money(Number(d.amount))}, ${payText({ pay_cash: Number(d.cash), pay_noncash: Number(d.noncash) })}; продавец ${d.seller_name}`);
  await clearCertDraft(user.id);
  await t.send(chat, `✅ Сертификат №<b>${escapeHtml(String(d.number))}</b> на ${money(Number(d.amount))} успешно продан. Действует до ${fmtDate(addMonthsIso(now, EXPIRY_MONTHS))}.`, menuFor(user));
}

// ───────── использование ─────────

async function getCert(id: number): Promise<Cert | null> {
  const { data, error } = await supabaseAdmin.from("certificates").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return (data as Cert | null) ?? null;
}

// Поиск сертификата по введённому номеру среди сертификатов своего города (списка консультанту не показываем).
async function findCertByNumber(store: string, text: string): Promise<Cert | null> {
  const number = text.trim().replace(/\s+/g, " ");
  if (!number) return null;
  const { data, error } = await supabaseAdmin
    .from("certificates")
    .select("*")
    .eq("store", store)
    .ilike("number", number.replace(/[\\%_]/g, "\\$&"))
    .limit(1);
  if (error) throw error;
  return ((data ?? [])[0] as Cert | undefined) ?? null;
}

// Почему сертификат нельзя использовать / вернуть сейчас (null — можно).
function unusableReason(c: Cert, forReturn: boolean): string | null {
  if (c.status === "used") return "уже использован";
  if (c.status === "returned") return "уже возвращён";
  if (c.status === "pending_use") return "ждёт решения руководителя";
  if (!forReturn && isExpired(c)) return "срок действия истёк — обратитесь к руководителю";
  return null;
}

async function startUse(t: Transport, user: CertUser) {
  await saveDraft(user.id, "usenumber", {}, true);
  await t.send(user.telegram_chat_id, "✅ <b>Использование сертификата</b>\nНапишите номер сертификата:", cancelMarkup);
}

const sameCity = (store: string, c: CheckInfo) => REGISTER_STORE[c.retailStoreId] === store;

async function showChecks(t: Transport, user: CertUser, certId: number, page: number) {
  const chat = user.telegram_chat_id;
  const cert = await getCert(certId);
  if (!cert || cert.status !== "active" || cert.store !== user.store) {
    await t.send(chat, "Этот сертификат сейчас недоступен.", menuFor(user));
    return;
  }
  const date = businessDate();
  let checks: CheckInfo[];
  try {
    checks = (await fetchChecksForDate(date)).filter((c) => sameCity(user.store, c));
  } catch {
    await t.send(chat, "Не удалось получить чеки из МойСклад. Нажмите «Использовать» ещё раз через минуту.", menuFor(user));
    return;
  }
  checks.sort((a, b) => b.moment.localeCompare(a.moment));
  const { data: linked } = await supabaseAdmin.from("certificates").select("use_demand_id").in("status", ["used", "pending_use"]).not("use_demand_id", "is", null);
  const linkedIds = new Set((linked ?? []).map((r) => r.use_demand_id as string));
  const pages = Math.max(1, Math.ceil(checks.length / CHECKS_PER_PAGE));
  const p = Math.min(Math.max(page, 0), pages - 1);
  const slice = checks.slice(p * CHECKS_PER_PAGE, (p + 1) * CHECKS_PER_PAGE);
  await saveDraft(user.id, "pickcheck", { certId }, false);
  const nav: { text: string; callback_data: string }[] = [];
  if (p > 0) nav.push({ text: "‹ Новее", callback_data: `cs:uc:${certId}:${p - 1}` });
  if (p < pages - 1) nav.push({ text: "Старше ›", callback_data: `cs:uc:${certId}:${p + 1}` });
  const head = `На какой чек использовать сертификат №<b>${escapeHtml(cert.number)}</b> (${money(cert.amount)})?\nЧеки за ${fmtDate(`${date}T12:00:00+05:00`)}${pages > 1 ? `, страница ${p + 1} из ${pages}` : ""}:`;
  await t.send(chat, checks.length === 0 ? `${head}\n\nЧеков за сегодня пока нет.` : head, {
    inline_keyboard: [
      ...slice.map((c) => [{ text: `${linkedIds.has(c.id) ? "🎟 " : ""}${almatyTime(c.moment)} · ${c.cashier} · ${money(c.sum)}`, callback_data: `cs:ud:${certId}:${c.id}` }]),
      ...(nav.length ? [nav] : []),
      CANCEL_ROW,
    ],
  });
}

// Сверка способа оплаты сертификата с оплатой чека: чек должен покрывать сумму сертификата тем же способом
// (наличные — наличными, безнал — безналом). Если на чек уже привязаны другие сертификаты, их доли суммируются.
// Если чек меньше номинала, сертификат используется целиком, а остаток сгорает; тогда сверяем пропорционально.
export function checkPayment(cert: Pick<Cert, "id" | "amount" | "pay_cash" | "pay_noncash">, demand: CheckInfo, others: Pick<Cert, "amount" | "pay_cash" | "pay_noncash">[]): { ok: boolean; problems: string[]; burned: number } {
  const need = (c: Pick<Cert, "amount" | "pay_cash" | "pay_noncash">) => {
    const f = Math.min(demand.sum, c.amount) / c.amount;
    return { cash: c.pay_cash * f, non: c.pay_noncash * f };
  };
  let needCash = 0;
  let needNon = 0;
  for (const c of [cert, ...others]) {
    const n = need(c);
    needCash += n.cash;
    needNon += n.non;
  }
  const problems: string[] = [];
  if (demand.sum <= 0) problems.push("сумма чека нулевая");
  if (needCash > demand.cash + TOLERANCE) problems.push(`в чеке наличными ${money(demand.cash)}, а сертификат оплачен наличными (нужно не меньше ${money(Math.round(needCash))})`);
  if (needNon > demand.noncash + TOLERANCE) problems.push(`в чеке безналом ${money(demand.noncash)}, а сертификат оплачен безналом (нужно не меньше ${money(Math.round(needNon))})`);
  return { ok: problems.length === 0, problems, burned: Math.max(0, cert.amount - demand.sum) };
}

function describeCheck(c: CheckInfo): string {
  return `Чек №${escapeHtml(c.name)} · ${almatyTime(c.moment)} · ${escapeHtml(c.cashier)}\nСумма ${money(c.sum)} (нал ${money(c.cash)}, безнал ${money(c.noncash)})`;
}

async function attachedOthers(demandId: string, exceptId: number) {
  const { data, error } = await supabaseAdmin
    .from("certificates")
    .select("id, amount, pay_cash, pay_noncash")
    .eq("use_demand_id", demandId)
    .eq("status", "used")
    .neq("id", exceptId);
  if (error) throw error;
  return (data ?? []) as Pick<Cert, "id" | "amount" | "pay_cash" | "pay_noncash">[];
}

async function pickCheck(t: Transport, user: CertUser, certId: number, demandId: string) {
  const chat = user.telegram_chat_id;
  const cert = await getCert(certId);
  if (!cert || cert.status !== "active" || cert.store !== user.store) {
    await t.send(chat, "Этот сертификат сейчас недоступен.", menuFor(user));
    return;
  }
  let demand: CheckInfo | null;
  try {
    demand = await fetchCheckById(demandId);
  } catch {
    await t.send(chat, "Не удалось получить чек из МойСклад. Выберите чек ещё раз через минуту.");
    return;
  }
  if (!demand || !sameCity(user.store, demand)) {
    await t.send(chat, "Чек не найден или он не из вашего города.", menuFor(user));
    return;
  }
  const res = checkPayment(cert, demand, await attachedOthers(demand.id, cert.id));
  const data = { certId, demandId: demand.id };
  const burn = res.burned > 0 ? `\n⚠️ Чек меньше номинала — остаток ${money(res.burned)} сгорит.` : "";
  if (res.ok) {
    await saveDraft(user.id, "confirm_use", data, false);
    await t.send(chat, `Сертификат №<b>${escapeHtml(cert.number)}</b> (${money(cert.amount)}, ${payText(cert)}) → ${describeCheck(demand)}${burn}\n\nИспользовать?`, {
      inline_keyboard: [[{ text: "✅ Да, использовать", callback_data: "cs:uy" }, { text: "Нет", callback_data: "cs:x" }]],
    });
    return;
  }
  await saveDraft(user.id, "mismatch", data, false);
  await t.send(
    chat,
    `⚠️ <b>Способ оплаты чека не совпадает с сертификатом</b>\nСертификат №${escapeHtml(cert.number)}: ${money(cert.amount)}, ${payText(cert)}.\n${describeCheck(demand)}\n\n${res.problems.map((p) => `• ${p}`).join("\n")}\n\nВыберите другой чек. Если нужен именно этот, подтвердить его должен руководитель — отправьте запрос.`,
    {
      inline_keyboard: [
        [{ text: "Выбрать другой чек", callback_data: `cs:uc:${certId}:0` }],
        [{ text: "Нужен именно этот чек — запрос руководителю", callback_data: "cs:ur" }],
        CANCEL_ROW,
      ],
    }
  );
}

async function markUsed(cert: Cert, demand: CheckInfo, actor: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("certificates")
    .update({
      status: "used",
      use_demand_id: demand.id,
      use_demand_name: demand.name,
      use_demand_moment: demand.moment,
      use_demand_sum: demand.sum,
      use_demand_cash: demand.cash,
      use_demand_noncash: demand.noncash,
      use_demand_cashier: demand.cashier,
      use_problem: null,
      used_at: new Date().toISOString(),
    })
    .eq("id", cert.id)
    .in("status", ["active", "pending_use"])
    .select("id");
  if (error) throw error;
  if (!data || data.length === 0) return false;
  await logEvent(cert.id, actor, "used", `чек №${demand.name} (${demand.id}), ${money(demand.sum)}`);
  return true;
}

async function finishUse(t: Transport, user: CertUser) {
  const chat = user.telegram_chat_id;
  const draft = await getDraft(user.id);
  if (!draft || draft.step !== "confirm_use") {
    await t.send(chat, "Использование уже оформлено или отменено.", menuFor(user));
    return;
  }
  const cert = await getCert(Number(draft.data.certId));
  const demand = cert ? await fetchCheckById(String(draft.data.demandId)) : null;
  await clearCertDraft(user.id);
  if (!cert || !demand || cert.status !== "active") {
    await t.send(chat, "Не удалось оформить: сертификат или чек уже изменились. Начните заново.", menuFor(user));
    return;
  }
  const res = checkPayment(cert, demand, await attachedOthers(demand.id, cert.id));
  if (!res.ok) {
    await t.send(chat, `Оплата чека изменилась и больше не совпадает с сертификатом:\n${res.problems.map((p) => `• ${p}`).join("\n")}\nВыберите чек ещё раз.`, menuFor(user));
    return;
  }
  if (!(await markUsed(cert, demand, user.employee_name))) {
    await t.send(chat, "Сертификат уже использован или изменился.", menuFor(user));
    return;
  }
  await t.send(chat, `✅ Сертификат №<b>${escapeHtml(cert.number)}</b> успешно использован на чек №${escapeHtml(demand.name)}.`, menuFor(user));
}

// Владельцу: запрос на подтверждение привязки с несовпадающей оплатой.
async function ownerChats(): Promise<number[]> {
  const { data, error } = await supabaseAdmin.from("coach_users").select("telegram_chat_id").eq("is_protected", true).eq("status", "approved");
  if (error) throw error;
  return (data ?? []).map((r) => r.telegram_chat_id as number);
}

async function sendRequestToOwner(t: Transport, user: CertUser, cert: Cert, demand: CheckInfo, problems: string[]) {
  const text = [
    `🎟 <b>Сертификат №${escapeHtml(cert.number)} ждёт решения</b> · ${cityName(cert.store)}`,
    `Номинал ${money(cert.amount)}, оплачен: ${payText(cert)}. Продал: ${escapeHtml(cert.seller_name)}.`,
    `${describeCheck(demand)}\n<a href="${mdLink(demand.id)}">Открыть чек в МойСклад</a>`,
    `Запросил: ${escapeHtml(user.employee_name)}.`,
    `Не совпадает:\n${problems.map((p) => `• ${p}`).join("\n")}`,
    "Исправьте способ оплаты чека в МойСклад и нажмите «Проверить чек ещё раз», либо откажите — сотрудник выберет другой чек.",
  ].join("\n\n");
  const markup: ReplyMarkup = {
    inline_keyboard: [[{ text: "🔄 Проверить чек ещё раз", callback_data: `cr:re:${cert.id}` }], [{ text: "Отказать", callback_data: `cr:no:${cert.id}` }]],
  };
  for (const chat of await ownerChats()) await t.send(chat, text, markup);
}

async function requestOwner(t: Transport, user: CertUser) {
  const chat = user.telegram_chat_id;
  const draft = await getDraft(user.id);
  if (!draft || draft.step !== "mismatch") {
    await t.send(chat, "Запрос уже отправлен или отменён.", menuFor(user));
    return;
  }
  const cert = await getCert(Number(draft.data.certId));
  const demand = cert ? await fetchCheckById(String(draft.data.demandId)) : null;
  if (!cert || !demand || cert.status !== "active") {
    await clearCertDraft(user.id);
    await t.send(chat, "Сертификат или чек уже изменились. Начните заново.", menuFor(user));
    return;
  }
  const res = checkPayment(cert, demand, await attachedOthers(demand.id, cert.id));
  if (res.ok) {
    await clearCertDraft(user.id);
    await t.send(chat, "Оплата чека уже совпадает с сертификатом — нажмите «Использовать» и выберите чек заново.", menuFor(user));
    return;
  }
  const { data, error } = await supabaseAdmin
    .from("certificates")
    .update({
      status: "pending_use",
      use_demand_id: demand.id,
      use_demand_name: demand.name,
      use_demand_moment: demand.moment,
      use_demand_sum: demand.sum,
      use_demand_cash: demand.cash,
      use_demand_noncash: demand.noncash,
      use_demand_cashier: demand.cashier,
      use_requested_by: user.id,
      use_requested_at: new Date().toISOString(),
      use_problem: res.problems.join("; "),
    })
    .eq("id", cert.id)
    .eq("status", "active")
    .select("id");
  if (error) throw error;
  await clearCertDraft(user.id);
  if (!data || data.length === 0) {
    await t.send(chat, "Сертификат уже изменился. Начните заново.", menuFor(user));
    return;
  }
  await logEvent(cert.id, user.employee_name, "use_requested", `чек №${demand.name}; ${res.problems.join("; ")}`);
  await sendRequestToOwner(t, user, cert, demand, res.problems);
  await t.send(chat, `Запрос по сертификату №<b>${escapeHtml(cert.number)}</b> отправлен руководителю. Пока он не решит, сертификат не считается использованным — вам придёт сообщение.`, menuFor(user));
}

// ───────── возврат ─────────

async function startReturn(t: Transport, user: CertUser) {
  await saveDraft(user.id, "returnnumber", {}, true);
  await t.send(user.telegram_chat_id, "↩️ <b>Возврат сертификата</b>\nНапишите номер сертификата, который возвращают:", cancelMarkup);
}

async function finishReturn(t: Transport, user: CertUser, certId: number) {
  const chat = user.telegram_chat_id;
  const { data, error } = await supabaseAdmin
    .from("certificates")
    .update({ status: "returned", returned_at: new Date().toISOString(), returned_by: user.employee_name })
    .eq("id", certId)
    .eq("store", user.store)
    .eq("status", "active")
    .select("number, amount");
  if (error) throw error;
  await clearCertDraft(user.id);
  if (!data || data.length === 0) {
    await t.send(chat, "Этот сертификат уже нельзя вернуть (использован, возвращён или ждёт решения).", menuFor(user));
    return;
  }
  await logEvent(certId, user.employee_name, "returned", money(data[0].amount));
  await t.send(chat, `✅ Возврат сертификата №<b>${escapeHtml(data[0].number)}</b> (${money(data[0].amount)}) оформлен. Использовать его больше нельзя.`, menuFor(user));
}

// ───────── кнопки консультанта ─────────

export async function handleCertCallback(data: string, t: Transport, user: CertUser, dropCurrent: () => Promise<void>): Promise<void> {
  const chat = user.telegram_chat_id;
  const [, action, a, b] = data.split(":");
  await dropCurrent();
  if (action === "x") {
    await clearCertDraft(user.id);
    await t.send(chat, "Отменено.", menuFor(user));
    return;
  }
  if (action === "m") return sendConsultantMenu(t, user);
  if (action === "sell") return startSell(t, user);
  if (action === "use") return startUse(t, user);
  if (action === "ret") return startReturn(t, user);

  const draft = await getDraft(user.id);
  if (action === "se") {
    if (!draft || draft.step !== "seller") return void (await t.send(chat, "Начните заново: нажмите «Сертификат».", menuFor(user)));
    const sellers = await citySellers(user.store).catch(() => []);
    const seller = sellers.find((s) => s.id === a);
    if (!seller) return void (await t.send(chat, "Не нашёл этого сотрудника. Начните заново.", menuFor(user)));
    await saveDraft(user.id, "amount", { seller_id: seller.id, seller_name: seller.name }, true);
    await t.send(chat, `Продаёт: <b>${escapeHtml(seller.name)}</b>.\nНа какую сумму сертификат? (тенге)`, cancelMarkup);
    return;
  }
  if (action === "pm") {
    if (!draft || draft.step !== "pay") return void (await t.send(chat, "Начните заново: нажмите «Сертификат».", menuFor(user)));
    const amount = Number(draft.data.amount);
    if (a === "m") {
      await saveDraft(user.id, "mixed_non", draft.data, true);
      await t.send(chat, `Смешанная оплата, номинал ${money(amount)}. Сколько оплачено <b>безналом</b>?`, cancelMarkup);
      return;
    }
    const cash = a === "c" ? amount : 0;
    await askClientName(t, user, { step: "client", data: { ...draft.data, cash, noncash: amount - cash } });
    return;
  }
  if (action === "sy") return finishSell(t, user);
  if (action === "uc") return showChecks(t, user, Number(a), Number(b ?? 0));
  if (action === "ud") return pickCheck(t, user, Number(a), String(b));
  if (action === "uy") return finishUse(t, user);
  if (action === "ur") return requestOwner(t, user);
  if (action === "ry") {
    if (!draft || draft.step !== "confirm_return" || Number(draft.data.certId) !== Number(a)) return void (await t.send(chat, "Возврат уже оформлен или отменён.", menuFor(user)));
    return finishReturn(t, user, Number(a));
  }
}

// ───────── решения главного владельца ─────────

async function consultantChat(userId: number | null): Promise<number | null> {
  if (!userId) return null;
  const { data } = await supabaseAdmin.from("coach_users").select("telegram_chat_id").eq("id", userId).maybeSingle();
  return (data?.telegram_chat_id as number | undefined) ?? null;
}

export async function handleCertOwnerCallback(
  data: string,
  t: Transport,
  chatId: number,
  ownerName: string,
  clearCurrent: () => Promise<void>
): Promise<void> {
  const [, action, idRaw] = data.split(":");
  const cert = await getCert(Number(idRaw));
  if (!cert) return void (await t.send(chatId, "Сертификат не найден."));

  if (action === "no" || action === "re") {
    if (cert.status !== "pending_use") {
      await clearCurrent();
      return void (await t.send(chatId, `По сертификату №${escapeHtml(cert.number)} решение уже принято.`));
    }
    const requester = await consultantChat(cert.use_requested_by);
    if (action === "no") {
      const { data: upd, error } = await supabaseAdmin
        .from("certificates")
        .update({ status: "active", use_demand_id: null, use_demand_name: null, use_demand_moment: null, use_demand_sum: null, use_demand_cash: null, use_demand_noncash: null, use_demand_cashier: null, use_requested_by: null, use_requested_at: null, use_problem: null })
        .eq("id", cert.id)
        .eq("status", "pending_use")
        .select("id");
      if (error) throw error;
      await clearCurrent();
      if (!upd || upd.length === 0) return void (await t.send(chatId, "Решение по этому сертификату уже принято."));
      await logEvent(cert.id, ownerName, "use_rejected", `чек №${cert.use_demand_name}`);
      await t.send(chatId, `Отказано по сертификату №${escapeHtml(cert.number)}. Он остался неиспользованным.`);
      if (requester) await t.send(requester, `Руководитель отказал по сертификату №<b>${escapeHtml(cert.number)}</b> (чек №${escapeHtml(cert.use_demand_name ?? "")}): способ оплаты чека не совпадает с сертификатом. Выберите другой чек или попросите исправить оплату и повторите «Сертификат → Использовать».`);
      return;
    }
    // Проверить чек ещё раз: оплату могли исправить в МойСклад.
    const demand = cert.use_demand_id ? await fetchCheckById(cert.use_demand_id) : null;
    if (!demand) return void (await t.send(chatId, "Не удалось получить чек из МойСклад. Нажмите ещё раз через минуту."));
    const res = checkPayment(cert, demand, await attachedOthers(demand.id, cert.id));
    if (!res.ok) {
      await t.send(chatId, `Пока не совпадает (чек №${escapeHtml(demand.name)}: нал ${money(demand.cash)}, безнал ${money(demand.noncash)}; сертификат: ${payText(cert)}):\n${res.problems.map((p) => `• ${p}`).join("\n")}\nИсправьте оплату в МойСклад и нажмите «Проверить чек ещё раз» снова.`);
      return;
    }
    if (!(await markUsed(cert, demand, ownerName))) {
      await clearCurrent();
      return void (await t.send(chatId, "Решение по этому сертификату уже принято."));
    }
    await clearCurrent();
    await t.send(chatId, `✅ Оплата чека №${escapeHtml(demand.name)} теперь совпадает. Сертификат №${escapeHtml(cert.number)} использован.`);
    if (requester) await t.send(requester, `✅ Способ оплаты чека №<b>${escapeHtml(demand.name)}</b> исправили. Сертификат №<b>${escapeHtml(cert.number)}</b> успешно использован.`);
    return;
  }

  if (action === "ru" || action === "rk") {
    // Решение после ночного сообщения «по чеку был возврат».
    await clearCurrent();
    if (cert.status !== "used" || cert.demand_return_decision) return void (await t.send(chatId, `По сертификату №${escapeHtml(cert.number)} решение уже принято.`));
    if (action === "rk") {
      await supabaseAdmin.from("certificates").update({ demand_return_decision: "kept" }).eq("id", cert.id);
      await logEvent(cert.id, ownerName, "return_flag_kept");
      return void (await t.send(chatId, `Сертификат №${escapeHtml(cert.number)} остаётся использованным.`));
    }
    const { error } = await supabaseAdmin
      .from("certificates")
      .update({ status: "active", demand_return_decision: "restored", use_demand_id: null, use_demand_name: null, use_demand_moment: null, use_demand_sum: null, use_demand_cash: null, use_demand_noncash: null, use_demand_cashier: null, used_at: null })
      .eq("id", cert.id)
      .eq("status", "used");
    if (error) throw error;
    await logEvent(cert.id, ownerName, "return_flag_restored", `был чек №${cert.use_demand_name}`);
    await t.send(chatId, `Сертификат №${escapeHtml(cert.number)} снова неиспользованный — им можно расплатиться ещё раз.`);
  }
}

// ───────── списки для администраторов и владельцев ─────────

type Kind = "s" | "u" | "n" | "e";
type Per = "pm" | "pw" | "tw" | "tm" | "all";
const KIND_LABEL: Record<Kind, string> = { s: "Проданные", u: "Использованные", n: "Не использованные", e: "Просроченные" };
const PER_LABEL: Record<Per, string> = { pm: "Прошлый месяц", pw: "Прошлая неделя", tw: "Эта неделя", tm: "Этот месяц", all: "За всё время" };

export async function sendCertAdminMenu(t: Transport, chatId: number) {
  await t.send(chatId, "🎟 <b>Сертификаты</b>\nКакой список показать?", {
    inline_keyboard: (["s", "u", "n", "e"] as Kind[]).map((k) => [{ text: KIND_LABEL[k], callback_data: `ca:k:${k}` }]),
  });
}

function periodRange(per: Per): { from: string; to: string } | null {
  const today = todayInAlmaty();
  if (per === "all") return null;
  if (per === "tm") return { from: monthStartOf(today), to: today };
  if (per === "tw") return { from: mondayOf(today), to: today };
  if (per === "pw") {
    const mon = addDays(mondayOf(today), -7);
    return { from: mon, to: addDays(mon, 6) };
  }
  const lastDayPrev = addDays(monthStartOf(today), -1);
  return { from: monthStartOf(lastDayPrev), to: lastDayPrev };
}

const atStart = (date: string) => new Date(`${date}T00:00:00+05:00`).toISOString();

function certLine(c: Cert, kind: Kind): string {
  const flags: string[] = [];
  if (c.status === "returned") flags.push("↩️ возвращён");
  if (c.status === "pending_use") flags.push("⏳ ждёт решения руководителя");
  if (c.status === "active" && isExpired(c)) flags.push("⌛ срок истёк");
  if (c.status === "used" && c.demand_return_noticed_at && c.demand_return_decision !== "kept") flags.push(`⚠️ по чеку был возврат ${money(c.demand_return_sum)}`);
  const lines = [
    `№<b>${escapeHtml(c.number)}</b> · ${money(c.amount)} · ${payText(c)}${flags.length ? ` · ${flags.join(", ")}` : ""}`,
    `   продал ${escapeHtml(c.seller_name)} · ${fmtDate(c.sold_at)} · клиент ${escapeHtml(c.client_name)}, ${escapeHtml(fmtPhone(c.client_phone))}`,
  ];
  if (kind === "u" && c.use_demand_id) {
    lines.push(`   использован ${c.used_at ? fmtDate(c.used_at) : ""} на чек <a href="${mdLink(c.use_demand_id)}">№${escapeHtml(c.use_demand_name ?? "")}</a> · ${escapeHtml(c.use_demand_cashier ?? "")} · ${money(c.use_demand_sum ?? 0)}`);
  } else if (c.status === "used" && c.use_demand_id) {
    lines.push(`   использован на чек <a href="${mdLink(c.use_demand_id)}">№${escapeHtml(c.use_demand_name ?? "")}</a>`);
  }
  if (kind === "e") lines.push(`   срок истёк ${fmtDate(c.expires_at)}`);
  else if (c.status === "active") lines.push(`   действует до ${fmtDate(c.expires_at)}`);
  return lines.join("\n");
}

function chunkText(head: string, blocks: string[]): string[] {
  const out: string[] = [];
  let cur = head;
  for (const b of blocks) {
    if (cur.length + b.length + 2 > 3800) {
      out.push(cur);
      cur = "";
    }
    cur += (cur ? "\n\n" : "") + b;
  }
  if (cur) out.push(cur);
  return out;
}

async function sendList(t: Transport, chatId: number, kind: Kind, stores: string[], per: Per) {
  const range = periodRange(per);
  const parts: string[] = [];
  let total = 0;
  let sum = 0;
  for (const store of stores) {
    let q = supabaseAdmin.from("certificates").select("*").eq("store", store);
    // «Просроченные» — неиспользованные с истёкшим сроком; период — по дате окончания срока.
    const dateCol = kind === "u" ? "used_at" : kind === "e" ? "expires_at" : "sold_at";
    if (kind === "u") q = q.eq("status", "used");
    if (kind === "n") q = q.in("status", ["active", "pending_use"]);
    if (kind === "e") q = q.eq("status", "active").lt("expires_at", new Date().toISOString());
    if (range) q = q.gte(dateCol, atStart(range.from)).lt(dateCol, atStart(addDays(range.to, 1)));
    const { data, error } = await q.order(dateCol, { ascending: true }).limit(500);
    if (error) throw error;
    // «Не использованные» — только действующие: с истёкшим сроком они в «Просроченных».
    const rows = ((data ?? []) as Cert[]).filter((c) => kind !== "n" || c.status !== "active" || !isExpired(c));
    total += rows.length;
    sum += rows.filter((c) => c.status !== "returned").reduce((a, c) => a + c.amount, 0);
    const title = `<b>${KIND_LABEL[kind]} · ${cityName(store)} · ${PER_LABEL[per]}${range ? ` (${fmtDate(`${range.from}T12:00:00+05:00`)}–${fmtDate(`${range.to}T12:00:00+05:00`)})` : ""}</b>`;
    const sub = rows.length === 0 ? "Сертификатов нет." : `Всего: ${rows.length} шт на ${money(rows.filter((c) => c.status !== "returned").reduce((a, c) => a + c.amount, 0))}`;
    const blocks = rows.map((c) => certLine(c, kind));
    parts.push(...chunkText(`${title}\n${sub}`, blocks));
  }
  if (stores.length > 1 && total > 0) parts.push(`<b>Итого по всем городам:</b> ${total} шт на ${money(sum)}`);
  for (const msg of parts) await t.send(chatId, msg);
}

export async function handleCertAdminCallback(data: string, t: Transport, chatId: number, stores: string[], dropCurrent: () => Promise<void>): Promise<void> {
  const [, action, kind, a, b] = data.split(":");
  const k = kind as Kind;
  if (action !== "k" && action !== "c" && action !== "p") return;
  if (!KIND_LABEL[k]) return;
  await dropCurrent();
  const periodMenu = async (store: string, back: string) => {
    await t.send(chatId, `🎟 <b>${KIND_LABEL[k]}${store === "all" ? "" : ` · ${cityName(store)}`}</b>\nЗа какой период?`, {
      inline_keyboard: [...(["pm", "pw", "tw", "tm", "all"] as Per[]).map((p) => [{ text: PER_LABEL[p], callback_data: `ca:p:${k}:${store}:${p}` }]), [{ text: "← Назад", callback_data: back }]],
    });
  };
  if (action === "k") {
    if (stores.length === 1) return periodMenu(stores[0], "ca:m:s");
    await t.send(chatId, `🎟 <b>${KIND_LABEL[k]}</b>\nВыберите город:`, {
      inline_keyboard: [...stores.map((s) => [{ text: cityName(s), callback_data: `ca:c:${k}:${s}` }]), [{ text: "Все города", callback_data: `ca:c:${k}:all` }], [{ text: "← Назад", callback_data: "ca:m:s" }]],
    });
    return;
  }
  if (action === "c") {
    if (a !== "all" && !stores.includes(a)) return;
    return periodMenu(a, `ca:k:${k}`);
  }
  // p: период выбран — показать список
  if (!(a === "all" ? stores.length > 0 : stores.includes(a)) || !PER_LABEL[b as Per]) return;
  await sendList(t, chatId, k, a === "all" ? stores : [a], b as Per);
}

// ───────── ночная проверка возвратов по чекам ─────────

// Возвраты за день (retailsalesreturn ссылается на чек полем demand). Если чек привязан к использованному
// сертификату — помечаем и сообщаем главному владельцу: автоматически сертификат не возвращаем, решает владелец.
export async function checkCertificateReturns(
  t: Transport,
  date: string,
  returns: { sum: number; demand?: { meta?: { href?: string } } | null }[]
): Promise<{ matched: number }> {
  const byDemand = new Map<string, number>();
  for (const r of returns) {
    const id = r.demand?.meta?.href?.split("/").pop()?.split("?")[0];
    if (id) byDemand.set(id, (byDemand.get(id) ?? 0) + Math.round((r.sum ?? 0) / 100));
  }
  if (byDemand.size === 0) return { matched: 0 };
  const { data, error } = await supabaseAdmin.from("certificates").select("*").eq("status", "used").in("use_demand_id", [...byDemand.keys()]);
  if (error) throw error;
  let matched = 0;
  for (const c of (data ?? []) as Cert[]) {
    if (c.demand_return_last_date && c.demand_return_last_date >= date) continue; // этот день уже учтён
    const returned = byDemand.get(c.use_demand_id ?? "") ?? 0;
    const total = c.demand_return_sum + returned;
    const { error: upErr } = await supabaseAdmin
      .from("certificates")
      .update({ demand_return_noticed_at: new Date().toISOString(), demand_return_sum: total, demand_return_last_date: date, demand_return_decision: null })
      .eq("id", c.id);
    if (upErr) throw upErr;
    await logEvent(c.id, "система", "demand_return", `${date}: ${money(returned)} по чеку №${c.use_demand_name}`);
    matched += 1;
    const full = total >= (c.use_demand_sum ?? 0) - TOLERANCE;
    const text = `⚠️ <b>По чеку сертификата был возврат</b> · ${cityName(c.store)}\nСертификат №<b>${escapeHtml(c.number)}</b> (${money(c.amount)}), использован на чек <a href="${mdLink(c.use_demand_id ?? "")}">№${escapeHtml(c.use_demand_name ?? "")}</a> (${money(c.use_demand_sum ?? 0)}).\nВозврат ${fmtDate(`${date}T12:00:00+05:00`)}: ${money(returned)}${total !== returned ? `, всего ${money(total)}` : ""} — ${full ? "чек возвращён полностью" : "возврат частичный"}.\n\nЕсли сертификат вернули клиенту для повторного использования, верните его в неиспользованные.`;
    const markup: ReplyMarkup = { inline_keyboard: [[{ text: "Вернуть в неиспользованные", callback_data: `cr:ru:${c.id}` }], [{ text: "Оставить использованным", callback_data: `cr:rk:${c.id}` }]] };
    for (const chat of await ownerChats()) await t.send(chat, text, markup);
  }
  return { matched };
}
