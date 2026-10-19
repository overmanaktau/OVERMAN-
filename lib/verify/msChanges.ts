// Проверка журнала изменений МойСклад: правки чеков и возвратов (кроме обычных продаж с кассы) читаются из аудита,
// записываются в moysklad_change_log, а дни, которых они касаются, пересчитываются в портале — тем же адресом
// синхронизации, что и ночью. Телеграм-отчёты читают данные портала, поэтому они меняются вместе с ним.
// Владельцу в личку — сводка, что именно поменяли.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getErrorMessage } from "@/lib/errors";
import { fetchAuditAll, fetchAuditEvents, fetchAuditRecords, fetchEmployeeLogins, type AuditRecord } from "@/lib/moyskladAudit";
import { notifyOwner } from "@/lib/verify/notifyOwner";
import { escapeHtml } from "@/lib/telegram";
import { shortName } from "@/lib/reports/sales";

const MAX_DAYS_PER_RUN = 25;

function almatyToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Almaty" }).format(new Date());
}
const msStamp = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
const dm = (ymd: string) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}`;

export type ChangesSummary = {
  since: string;
  records: number; // записей журнала по чекам и возвратам (без обычных продаж с кассы)
  events: number;
  affectedDays: string[];
  resynced: string[];
  failed: string[];
  pendingLeft: number;
  lines: string[];
};

export async function checkMsChanges(opts: { origin: string; secret: string; since?: string; apply?: boolean; notify?: boolean }): Promise<ChangesSummary> {
  const apply = opts.apply !== false;
  const { data: st } = await supabaseAdmin.from("moysklad_sync_state").select("audit_cursor").eq("id", true).maybeSingle();
  const storedCursor = st?.audit_cursor as string | null | undefined;
  // Первый запуск без указанного момента: журнал читаем с «сейчас» (то, что было раньше, уже сверено с базой отдельно).
  if (!opts.since && !storedCursor) {
    const recent = await fetchAuditRecords("retaildemand", msStamp(new Date(Date.now() - 2 * 86400000)));
    const start = recent.reduce((m, r) => (r.moment > m ? r.moment : m), msStamp(new Date(Date.now() - 3600 * 1000)));
    if (opts.apply !== false) await supabaseAdmin.from("moysklad_sync_state").update({ audit_cursor: start }).eq("id", true);
    return { since: start, records: 0, events: 0, affectedDays: [], resynced: [], failed: [], pendingLeft: 0, lines: ["Курсор журнала установлен — изменения читаются с этого момента."] };
  }
  const since = opts.since ?? (storedCursor as string);

  // 1. Записи журнала с момента последней проверки
  // Запрос журнала по типу документа в МойСклад на промежутках в несколько дней отвечает по минуте и дольше (504), поэтому читаем весь журнал и отбираем чеки и возвраты сами.
  const every = await fetchAuditAll(since);
  const all: AuditRecord[] = every.filter((r) => r.entityType === "retaildemand" || r.entityType === "retailsalesreturn");
  const meaningful = all.filter((r) => !(r.eventType === "create" && r.source === "posapi")); // обычные продажи с кассы — не правка
  const logins = await fetchEmployeeLogins().catch(() => new Map<string, string>());

  // 2. Что именно поменялось (по каждой записи)
  const rows: Record<string, unknown>[] = [];
  const lines: string[] = [];
  let events = 0;
  const today = almatyToday();
  for (const rec of meaningful) {
    const evs = await fetchAuditEvents(rec.id);
    for (const e of evs) {
      events += 1;
      rows.push({
        audit_id: rec.id,
        entity_id: e.entityId,
        entity_type: rec.entityType,
        doc_name: e.name,
        doc_date: e.docDate,
        event_type: rec.eventType,
        source: rec.source,
        uid: rec.uid,
        at_ms: rec.moment,
        diff: e.diff,
        info: e.info,
        // правки сегодняшних документов отдельного пересчёта не требуют
        applied_at: e.docDate && e.docDate >= today ? new Date().toISOString() : null,
      });
      if (e.docDate && e.docDate < today) {
        const who = logins.get(rec.uid) ?? rec.uid;
        const kind = rec.entityType === "retailsalesreturn" ? "возврат" : "чек";
        let what = rec.eventType === "delete" ? "удалён" : rec.eventType === "create" ? "создан вручную" : "изменён";
        const owner = e.diff?.owner;
        if (owner) what = `ответственный ${shortName(logins.get(String(owner.oldValue)) ?? String(owner.oldValue ?? "—"))} → ${shortName(logins.get(String(owner.newValue)) ?? String(owner.newValue ?? "—"))}`;
        else if (e.diff) what = `изменено: ${Object.keys(e.diff).join(", ")}`;
        lines.push(`${kind} №${e.name} от ${dm(e.docDate)}: ${what} (${shortName(who)})`);
      }
    }
  }
  if (rows.length > 0) {
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await supabaseAdmin.from("moysklad_change_log").upsert(rows.slice(i, i + 200), { onConflict: "audit_id,entity_id", ignoreDuplicates: true });
      if (error) throw error;
    }
  }

  // 3. Пересчитать в портале дни, которых коснулись правки
  const { data: pending, error: pErr } = await supabaseAdmin.from("moysklad_change_log").select("doc_date").is("applied_at", null).not("doc_date", "is", null).lt("doc_date", today).order("doc_date");
  if (pErr) throw pErr;
  const affectedDays = [...new Set((pending ?? []).map((r) => r.doc_date as string))];
  const resynced: string[] = [];
  const failed: string[] = [];
  if (apply) {
    for (const date of affectedDays.slice(0, MAX_DAYS_PER_RUN)) {
      try {
        const res = await fetch(`${opts.origin}/api/moysklad/sync?date=${date}&skipCatalog=1`, { headers: { Authorization: `Bearer ${opts.secret}` }, signal: AbortSignal.timeout(240_000) });
        if (!res.ok) throw new Error(`ошибка ${res.status}`);
        await supabaseAdmin.from("moysklad_change_log").update({ applied_at: new Date().toISOString() }).eq("doc_date", date).is("applied_at", null);
        resynced.push(date);
      } catch (e) {
        failed.push(`${date}: ${getErrorMessage(e)}`);
      }
    }
  }

  // 4. Курсор — на последнюю прочитанную запись; сводка владельцу
  const last = every.reduce((m, r) => (r.moment > m ? r.moment : m), since);
  if (apply) await supabaseAdmin.from("moysklad_sync_state").update({ audit_cursor: last }).eq("id", true);
  if (opts.notify !== false && apply && (lines.length > 0 || failed.length > 0)) {
    const shown = lines.slice(0, 15).map((l) => `• ${escapeHtml(l)}`).join("\n");
    const more = lines.length > 15 ? `\n… и ещё ${lines.length - 15}` : "";
    const done = resynced.length > 0 ? `\n\nПерсчитано дней в портале и отчётах: ${resynced.length} (${resynced.map(dm).join(", ")}).` : "";
    const bad = failed.length > 0 ? `\n⚠️ Не удалось пересчитать: ${escapeHtml(failed.join("; "))}` : "";
    await notifyOwner(`🔄 <b>Изменения в МойСклад</b> (чеки и возвраты задним числом)\n${shown}${more}${done}${bad}`);
  }
  return { since, records: meaningful.length, events, affectedDays, resynced, failed, pendingLeft: Math.max(0, affectedDays.length - resynced.length - failed.length), lines };
}

// ---- Остальные изменения в МойСклад: товары, склад, документы, справочники (правило владельца 19.10.2026: «любое изменение должно ставить меня в курс») ----
// Не показываем то, что делает сама система: свои запросы портала (source remap-1.2: бонусы, клиенты), печать, входы, настройки интерфейса и обычную работу кассы (posapi:
// продажи, смены, внесения, клиенты); чеки и возвраты разбирает checkMsChanges. Остальное — правки из интерфейса МойСклад (товары, приёмки, перемещения, цены…) и любые удаления.
export const ENTITY_RU: Record<string, string> = {
  product: "товар", variant: "модификация", service: "услуга", bundle: "комплект", productfolder: "группа товаров", supply: "приёмка", enter: "оприходование", loss: "списание", move: "перемещение",
  inventory: "инвентаризация", purchaseorder: "заказ поставщику", purchasereturn: "возврат поставщику", customerorder: "заказ покупателя", demand: "отгрузка", salesreturn: "возврат покупателя",
  counterparty: "контрагент", store: "склад", employee: "сотрудник", retailstore: "точка продаж", bonusprogram: "бонусная программа", bonustransaction: "бонусная операция", pricelist: "прайс-лист",
  paymentin: "входящий платёж", paymentout: "исходящий платёж", cashin: "приходный ордер", cashout: "расходный ордер", invoiceout: "счёт покупателю", invoicein: "счёт поставщика",
  retaildemand: "чек", retailsalesreturn: "возврат", retaildrawercashin: "внесение", retaildrawercashout: "выплата", retailshift: "смена", user: "пользователь", role: "роль",
};
const NOISE_EVENTS = new Set(["print", "sendemailfromentity", "loginlogout", "export", "import", "sendtobooks", "download"]);
const NOISE_ENTITIES = new Set(["usersettings", "retaildemand", "retailsalesreturn", ""]);
const EVENT_RU: Record<string, string> = { create: "создан", update: "изменён", delete: "удалён" };
const FIELD_RU: Record<string, string> = {
  name: "название", salePrices: "цены продажи", buyPrice: "закупочная цена", minPrice: "минимальная цена", article: "артикул", code: "код", archived: "в архиве", description: "описание",
  positions: "позиции", sum: "сумма", store: "склад", agent: "контрагент", moment: "дата", applicable: "проведён", deleted: "удалён", productFolder: "группа", phone: "телефон", email: "почта", tags: "теги",
  owner: "ответственный", group: "отдел", barcodes: "штрихкоды", supplier: "поставщик", uom: "ед. измерения", weight: "вес", paymentItemType: "тип", attributes: "доп. поля",
};

export type OtherChangesSummary = { since: string; records: number; lines: string[] };

export async function checkOtherMsChanges(opts: { since?: string; apply?: boolean; notify?: boolean }): Promise<OtherChangesSummary> {
  const apply = opts.apply !== false;
  const { data: st } = await supabaseAdmin.from("moysklad_sync_state").select("audit_cursor_all").eq("id", true).maybeSingle();
  const stored = st?.audit_cursor_all as string | null | undefined;
  const since = opts.since ?? stored ?? msStamp(new Date(Date.now() - 24 * 3600 * 1000));
  const all = await fetchAuditAll(since);
  const meaningful = all.filter((r) => {
    if (NOISE_ENTITIES.has(r.entityType) || NOISE_EVENTS.has(r.eventType) || NOISE_EVENTS.has(r.source)) return false;
    if (r.source === "remap-1.2") return false; // свои запросы портала
    if (r.source === "posapi" && r.eventType !== "delete") return false; // обычная работа кассы
    return true;
  });
  const logins = await fetchEmployeeLogins().catch(() => new Map<string, string>());
  const rows: Record<string, unknown>[] = [];
  const lines: string[] = [];
  for (const rec of meaningful) {
    const evs = await fetchAuditEvents(rec.id).catch(() => []);
    const kind = ENTITY_RU[rec.entityType] ?? rec.entityType;
    const who = shortName(logins.get(rec.uid) ?? rec.uid);
    const act = EVENT_RU[rec.eventType] ?? rec.eventType;
    const list = evs.length > 0 ? evs : [{ entityId: rec.id, name: "", docDate: null, diff: null, info: "" }];
    for (const e of list) {
      rows.push({ audit_id: rec.id, entity_id: e.entityId || rec.id, entity_type: rec.entityType, doc_name: e.name, doc_date: e.docDate, event_type: rec.eventType, source: rec.source, uid: rec.uid, at_ms: rec.moment, diff: e.diff, info: e.info, applied_at: new Date().toISOString() });
      const fields = rec.eventType === "update" ? Object.keys(e.diff ?? {}).map((k) => FIELD_RU[k] ?? k) : [];
      lines.push(`${kind}${e.name ? ` «${e.name.slice(0, 60)}»` : ""} — ${act}${fields.length ? `: ${fields.join(", ")}` : ""} (${who})`);
    }
  }
  if (apply && rows.length > 0) {
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await supabaseAdmin.from("moysklad_change_log").upsert(rows.slice(i, i + 200), { onConflict: "audit_id,entity_id", ignoreDuplicates: true });
      if (error) throw error;
    }
  }
  const last = all.reduce((m, r) => (r.moment > m ? r.moment : m), since);
  if (apply) await supabaseAdmin.from("moysklad_sync_state").update({ audit_cursor_all: last }).eq("id", true);
  if (opts.notify !== false && apply && lines.length > 0) {
    const shown = lines.slice(0, 20).map((l) => `• ${escapeHtml(l)}`).join("\n");
    const more = lines.length > 20 ? `\n… и ещё ${lines.length - 20}` : "";
    await notifyOwner(`📦 <b>Изменения в МойСклад</b> (товары, склад, документы, справочники)\n${shown}${more}`);
  }
  return { since, records: meaningful.length, lines };
}
