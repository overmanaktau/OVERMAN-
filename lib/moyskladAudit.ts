// Журнал изменений МойСклад (аудит): кто и что менял в чеках и возвратах. Только чтение.
// Нужен, чтобы после правок в МойСклад (например, сменили ответственного у чека) портал и телеграм-отчёты
// показывали то же, что и склад: по журналу видно, за какие дни пересчитать данные.
const BASE_URL = "https://api.moysklad.ru/api/remap/1.2";

function token(): string {
  const t = process.env.MOYSKLAD_API_TOKEN;
  if (!t) throw new Error("MOYSKLAD_API_TOKEN не задан.");
  return t;
}

async function get(path: string, params?: Record<string, string>) {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token()}`, Accept: "application/json;charset=utf-8" } });
    if (res.status === 429 || res.status === 503) {
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`МойСклад API ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
    return res.json();
  }
  throw new Error("МойСклад API: слишком много запросов, попробуйте позже.");
}

export type AuditRecord = {
  id: string;
  moment: string; // как в МойСклад (строка), по ней и двигаем курсор
  uid: string; // логин того, кто менял
  source: string; // posapi — касса, app — интерфейс МойСклад, remap-1.2 — API
  eventType: string; // create | update | delete | …
  entityType: string;
  objectCount: number;
};

// Записи журнала по одному типу документов, начиная с момента `since` (строка в формате МойСклад).
export async function fetchAuditRecords(entityType: "retaildemand" | "retailsalesreturn", since: string): Promise<AuditRecord[]> {
  const out: AuditRecord[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await get("/audit", { limit: "100", offset: String(offset), order: "moment,asc", filter: `entityType=${entityType};moment>=${since}` });
    type Raw = { id: string; moment: string; uid?: string; source?: string; eventType?: string; entityType?: string; objectCount?: number };
    const rows: Raw[] = page.rows ?? [];
    for (const r of rows) {
      out.push({ id: r.id, moment: r.moment, uid: r.uid ?? "", source: r.source ?? "", eventType: r.eventType ?? "", entityType: r.entityType ?? entityType, objectCount: r.objectCount ?? 1 });
    }
    if (rows.length < 100) break;
  }
  return out;
}

export type AuditEvent = {
  entityId: string;
  name: string;
  docDate: string | null; // дата документа (из additionalInfo «от ГГГГ-ММ-ДД …»)
  diff: Record<string, { oldValue?: unknown; newValue?: unknown }> | null;
  info: string;
};

export async function fetchAuditEvents(auditId: string): Promise<AuditEvent[]> {
  const page = await get(`/audit/${auditId}/events`, { limit: "100" });
  type Raw = { name?: string; additionalInfo?: string; diff?: AuditEvent["diff"]; entity?: { meta?: { href?: string } } };
  return ((page.rows ?? []) as Raw[]).map((e) => ({
    entityId: e.entity?.meta?.href?.split("/").pop()?.split("?")[0] ?? "",
    name: e.name ?? "",
    docDate: e.additionalInfo?.match(/от (\d{4}-\d{2}-\d{2})/)?.[1] ?? null,
    diff: e.diff ?? null,
    info: e.additionalInfo ?? "",
  }));
}

// Логин сотрудника в МойСклад → имя (в журнале ответственный указан логином).
export async function fetchEmployeeLogins(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const page = await get("/entity/employee", { limit: "1000" });
  for (const e of (page.rows ?? []) as { uid?: string; name?: string }[]) if (e.uid && e.name) map.set(e.uid, e.name);
  return map;
}
