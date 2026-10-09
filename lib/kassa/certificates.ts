// Сертификаты на экране кассы — ровно та же логика и те же права, что у консультанта в Telegram-боте
// (lib/coach/certificates.ts): продать, использовать (привязка к чеку со сверкой способа оплаты), вернуть.
// Поиск только в городе входа; сертификат, который нельзя использовать (использован, возвращён, ждёт решения
// руководителя, срок истёк), «не найден» — причину не раскрываем.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchCheckById, fetchChecksForDate, type CheckInfo } from "@/lib/moysklad";
import { REGISTER_STORE } from "@/lib/registers";
import { telegramTransport } from "@/lib/coach/bot";
import {
  attachedOthers,
  businessDate,
  almatyTime,
  checkPayment,
  citySellers,
  findCertByNumber,
  isExpired,
  logEvent,
  markUsed,
  normalizePhone,
  parseAmount,
  payText,
  sendRequestToOwner,
  type CertUser,
} from "@/lib/coach/certificates";

const EXPIRY_MONTHS = 3;

type CertView = { id: number; number: string; amount: number; pay: string; payCash: number; payNoncash: number; seller: string; client: string; expiresAt: string };

async function usableCert(store: string, number: string) {
  const c = await findCertByNumber(store, number);
  if (!c || c.status !== "active" || isExpired(c)) return null;
  return c;
}

async function certById(store: string, id: number) {
  const { data, error } = await supabaseAdmin.from("certificates").select("*").eq("id", id).eq("store", store).maybeSingle();
  if (error) throw error;
  return data as Awaited<ReturnType<typeof findCertByNumber>>;
}

const view = (c: NonNullable<Awaited<ReturnType<typeof findCertByNumber>>>): CertView => ({
  id: c.id,
  number: c.number,
  amount: c.amount,
  pay: payText(c),
  payCash: c.pay_cash,
  payNoncash: c.pay_noncash,
  seller: c.seller_name,
  client: c.client_name,
  expiresAt: c.expires_at,
});

export async function lookup(store: string, number: string): Promise<{ found: boolean; cert?: CertView }> {
  const c = await usableCert(store, number);
  return c ? { found: true, cert: view(c) } : { found: false };
}

export async function sellers(store: string) {
  return citySellers(store);
}

export type CheckRow = { id: string; name: string; time: string; cashier: string; sum: number; cash: number; noncash: number; linked: boolean };

// Чеки торгового дня города (новые сверху); 🎟 — к чеку уже привязан сертификат.
export async function todayChecks(store: string): Promise<CheckRow[]> {
  const checks = (await fetchChecksForDate(businessDate())).filter((c) => REGISTER_STORE[c.retailStoreId] === store);
  checks.sort((a, b) => b.moment.localeCompare(a.moment));
  const { data } = await supabaseAdmin.from("certificates").select("use_demand_id").in("status", ["used", "pending_use"]).not("use_demand_id", "is", null);
  const linked = new Set((data ?? []).map((r) => r.use_demand_id as string));
  return checks.map((c) => ({ id: c.id, name: c.name, time: almatyTime(c.moment), cashier: c.cashier, sum: c.sum, cash: c.cash, noncash: c.noncash, linked: linked.has(c.id) }));
}

async function loadForUse(store: string, certId: number, demandId: string) {
  const cert = await certById(store, certId);
  if (!cert || cert.status !== "active" || isExpired(cert)) return { error: "Сертификат не найден." as const };
  const demand: CheckInfo | null = await fetchCheckById(demandId);
  if (!demand || REGISTER_STORE[demand.retailStoreId] !== store) return { error: "Чек не найден или он не из вашего города." as const };
  const res = checkPayment(cert, demand, await attachedOthers(demand.id, cert.id));
  return { cert, demand, res };
}

export async function verify(store: string, certId: number, demandId: string) {
  const r = await loadForUse(store, certId, demandId);
  if ("error" in r) return { error: r.error };
  return {
    ok: r.res.ok,
    problems: r.res.problems,
    burned: r.res.burned,
    demand: { id: r.demand.id, name: r.demand.name, sum: r.demand.sum, cash: r.demand.cash, noncash: r.demand.noncash, cashier: r.demand.cashier, time: almatyTime(r.demand.moment) },
  };
}

export async function use(store: string, certId: number, demandId: string, actor: string) {
  const r = await loadForUse(store, certId, demandId);
  if ("error" in r) return { error: r.error };
  if (!r.res.ok) return { error: "Оплата чека не совпадает с оплатой сертификата.", problems: r.res.problems };
  if (!(await markUsed(r.cert, r.demand, actor))) return { error: "Сертификат уже использован или изменился." };
  return { ok: true, number: r.cert.number, check: r.demand.name };
}

// Нужен именно этот чек, а оплата не совпала: запрос главному владельцу («Проверить чек ещё раз» / «Отказать»).
export async function requestOwner(store: string, certId: number, demandId: string, actor: string) {
  const r = await loadForUse(store, certId, demandId);
  if ("error" in r) return { error: r.error };
  if (r.res.ok) return { error: "Оплата чека уже совпадает с сертификатом — используйте его обычным способом." };
  const { data, error } = await supabaseAdmin
    .from("certificates")
    .update({
      status: "pending_use",
      use_demand_id: r.demand.id,
      use_demand_name: r.demand.name,
      use_demand_moment: r.demand.moment,
      use_demand_sum: r.demand.sum,
      use_demand_cash: r.demand.cash,
      use_demand_noncash: r.demand.noncash,
      use_demand_cashier: r.demand.cashier,
      use_requested_by: null,
      use_requested_at: new Date().toISOString(),
      use_problem: r.res.problems.join("; "),
    })
    .eq("id", r.cert.id)
    .eq("status", "active")
    .select("id");
  if (error) throw error;
  if (!data || data.length === 0) return { error: "Сертификат уже изменился." };
  await logEvent(r.cert.id, actor, "use_requested", `чек №${r.demand.name}; ${r.res.problems.join("; ")} (с экрана кассы)`);
  const requester = { employee_name: `${actor} (касса)` } as CertUser;
  await sendRequestToOwner(telegramTransport, requester, r.cert, r.demand, r.res.problems);
  return { ok: true };
}

export async function giveBack(store: string, certId: number, actor: string) {
  const { data, error } = await supabaseAdmin
    .from("certificates")
    .update({ status: "returned", returned_at: new Date().toISOString(), returned_by: actor })
    .eq("id", certId)
    .eq("store", store)
    .eq("status", "active")
    .select("number, amount");
  if (error) throw error;
  if (!data || data.length === 0) return { error: "Этот сертификат уже нельзя вернуть." };
  await logEvent(certId, actor, "returned", `${data[0].amount} ₸ (с экрана кассы)`);
  return { ok: true, number: data[0].number };
}

export type SellInput = { sellerId: string; amount: unknown; cash: unknown; noncash: unknown; client: string; phone: string; number: string };

export async function sell(store: string, input: SellInput, actor: string) {
  const amount = parseAmount(String(input.amount ?? ""));
  if (!amount) return { error: "Сумма сертификата указана неверно." };
  const cash = Number(input.cash) || 0;
  const noncash = Number(input.noncash) || 0;
  if (cash < 0 || noncash < 0 || cash + noncash !== amount) return { error: "Наличные и безнал в сумме должны давать номинал сертификата." };
  const client = String(input.client ?? "").trim().replace(/\s+/g, " ");
  if (client.length < 2 || client.length > 80) return { error: "Укажите имя клиента." };
  const phone = normalizePhone(String(input.phone ?? ""));
  if (!phone) return { error: "Номер телефона клиента указан неверно." };
  const number = String(input.number ?? "").trim().replace(/\s+/g, " ");
  if (number.length < 1 || number.length > 32) return { error: "Укажите номер сертификата." };
  const seller = (await citySellers(store)).find((s) => s.id === input.sellerId);
  if (!seller) return { error: "Выберите, кто продаёт сертификат." };
  if (await findCertByNumber(store, number)) return { error: `Сертификат с номером ${number} уже есть в вашем городе.` };
  const now = new Date();
  const expires = new Date(now);
  expires.setUTCMonth(expires.getUTCMonth() + EXPIRY_MONTHS);
  const { data, error } = await supabaseAdmin
    .from("certificates")
    .insert({
      store,
      number,
      amount,
      pay_cash: cash,
      pay_noncash: noncash,
      client_name: client,
      client_phone: phone,
      seller_ms_id: seller.id,
      seller_name: seller.name,
      created_by: null,
      sold_at: now.toISOString(),
      expires_at: expires.toISOString(),
      status: "active",
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") return { error: `Сертификат с номером ${number} уже есть в вашем городе.` };
    throw error;
  }
  await logEvent(data.id, actor, "sold", `${amount} ₸; продавец ${seller.name} (с экрана кассы)`);
  return { ok: true, number, expiresAt: expires.toISOString() };
}
