// Ночная сводка владельцу «что изменилось за последние сутки»: правки чеков в МойСклад, данные и план в портале, запросы на правку, сертификаты,
// сгорание бонусов, доступы и заявки сотрудников, таргет, подписчики бота клиентов, сбои и задержанные отчёты. Каждый раздел — только если было что показать.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { escapeHtml, packSections } from "@/lib/telegram";

const NL = "\n";
const money = (n: number) => `${Math.round(n).toLocaleString("ru-RU")} ₸`;
const alm = (iso: string) => new Date(new Date(iso).getTime() + 5 * 3600000).toISOString();
const dm = (iso: string) => `${alm(iso).slice(8, 10)}.${alm(iso).slice(5, 7)}`;
const hm = (iso: string) => alm(iso).slice(11, 16);
const ruDate = (ymd: string) => ymd.split("-").reverse().slice(0, 2).join(".");
const MAX_LINES = 12;

function section(title: string, lines: string[], total?: number): string | null {
  if (lines.length === 0) return null;
  const more = (total ?? lines.length) > MAX_LINES ? `${NL}…и ещё ${(total ?? lines.length) - MAX_LINES}` : "";
  return `<b>${title}</b>${NL}${lines.slice(0, MAX_LINES).join(NL)}${more}`;
}

const FIELD_RU: Record<string, string> = {
  owner: "ответственный",
  positions: "позиции",
  cashSum: "оплата наличными",
  noCashSum: "оплата безналом",
  moment: "дата и время",
  agent: "покупатель",
  sum: "сумма",
  applicable: "проведён",
  deleted: "удалён",
  retailStore: "касса",
  store: "склад",
  description: "комментарий",
};

async function safe<T>(label: string, errors: string[], fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    return fallback;
  }
}

export async function buildDailyChanges(sinceIso: string, untilIso: string): Promise<{ messages: string[]; empty: boolean; errors: string[] }> {
  const errors: string[] = [];
  const parts: (string | null)[] = [];

  // 1. МойСклад: правки чеков и возвратов задним числом (журнал изменений)
  const ms = await safe("МойСклад", errors, async () => {
    const { data, error } = await supabaseAdmin.from("moysklad_change_log").select("entity_type, doc_name, doc_date, event_type, uid, at_ms, diff, info").gte("detected_at", sinceIso).lt("detected_at", untilIso).order("at_ms", { ascending: true }).limit(200);
    if (error) throw error;
    return (data ?? []) as { entity_type: string; doc_name: string; doc_date: string | null; event_type: string; uid: string | null; at_ms: string | null; diff: Record<string, unknown> | null; info: string | null }[];
  }, []);
  parts.push(
    section(
      "🧾 МойСклад — правки чеков и возвратов",
      ms.map((r) => {
        const kind = r.entity_type === "retailsalesreturn" ? "возврат" : "чек";
        const fields = Object.keys(r.diff ?? {}).map((k) => FIELD_RU[k] ?? k);
        const what = r.event_type === "delete" ? "удалён" : fields.length ? `изменено: ${fields.join(", ")}` : "изменён";
        const info = (r.info ?? "").replace(/^от \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s*/, "").slice(0, 60);
        return `• ${kind} ${escapeHtml(r.doc_name)}${r.doc_date ? ` от ${ruDate(r.doc_date)}` : ""}${info ? ` · ${escapeHtml(info)}` : ""} — ${what} (${escapeHtml(r.uid ?? "?")})`;
      }),
      ms.length
    )
  );

  // 2. Портал: внесённые правки данных и планы
  const hist = await safe("История правок", errors, async () => {
    const { data, error } = await supabaseAdmin.from("edit_history").select("summary, changed_by_name, created_at").gte("created_at", sinceIso).lt("created_at", untilIso).order("created_at", { ascending: true }).limit(100);
    if (error) throw error;
    return (data ?? []) as { summary: string; changed_by_name: string; created_at: string }[];
  }, []);
  parts.push(section("✏️ Портал — правки данных", hist.map((r) => `• ${hm(r.created_at)} ${escapeHtml(r.summary)} — ${escapeHtml(r.changed_by_name)}`), hist.length));

  const plans = await safe("Планы", errors, async () => {
    const { data, error } = await supabaseAdmin.from("sales_plan_monthly").select("employee_name, plan_month, sales_plan, created_at").gte("created_at", sinceIso).lt("created_at", untilIso).limit(100);
    if (error) throw error;
    return (data ?? []) as { employee_name: string; plan_month: string; sales_plan: number | null; created_at: string }[];
  }, []);
  parts.push(section("🎯 План продаж — внесён", plans.map((r) => `• ${escapeHtml(r.employee_name)}, ${r.plan_month.slice(5, 7)}.${r.plan_month.slice(0, 4)}: ${money(Number(r.sales_plan) || 0)}`), plans.length));

  // 3. Запросы на правку (новые и рассмотренные)
  const reqs = await safe("Запросы", errors, async () => {
    const { data, error } = await supabaseAdmin.from("edit_requests").select("id, table_name, status, context, created_at, reviewed_at, reviewed_by_name").or(`and(created_at.gte.${sinceIso},created_at.lt.${untilIso}),and(reviewed_at.gte.${sinceIso},reviewed_at.lt.${untilIso})`).order("created_at", { ascending: true }).limit(100);
    if (error) throw error;
    return (data ?? []) as { id: number; table_name: string; status: string; context: string | null; created_at: string; reviewed_at: string | null; reviewed_by_name: string | null }[];
  }, []);
  const REQ_STATUS: Record<string, string> = { pending: "ждёт решения", approved: "одобрен", rejected: "отклонён", denied: "отклонён" };
  parts.push(section("📝 Запросы на правку", reqs.map((r) => `• №${r.id}: ${REQ_STATUS[r.status] ?? escapeHtml(r.status)}${r.reviewed_by_name ? ` (${escapeHtml(r.reviewed_by_name)})` : ""}${r.context ? ` — ${escapeHtml(r.context.replace(/\s+/g, " ").slice(0, 70))}` : ""}`), reqs.length));

  // 4. Сертификаты
  const certEv = await safe("Сертификаты", errors, async () => {
    const { data, error } = await supabaseAdmin.from("certificate_events").select("certificate_id, at, actor, action, note").gte("at", sinceIso).lt("at", untilIso).order("at", { ascending: true }).limit(100);
    if (error) throw error;
    const events = (data ?? []) as { certificate_id: number; at: string; actor: string; action: string; note: string | null }[];
    const ids = [...new Set(events.map((e) => e.certificate_id))];
    const nums = new Map<number, string>();
    if (ids.length) {
      const { data: certs } = await supabaseAdmin.from("certificates").select("id, number, store, amount").in("id", ids);
      for (const c of (certs ?? []) as { id: number; number: string; store: string; amount: number }[]) nums.set(c.id, `№${c.number} (${c.store === "point_3" ? "Актобе" : "Актау"}, ${money(c.amount)})`);
    }
    return events.map((e) => ({ ...e, label: nums.get(e.certificate_id) ?? `#${e.certificate_id}` }));
  }, [] as { certificate_id: number; at: string; actor: string; action: string; note: string | null; label: string }[]);
  const CERT_ACTION: Record<string, string> = { sold: "продан", used: "использован", returned: "возврат оформлен", use_requested: "запрос руководителю", use_rejected: "отказ руководителя", use_cancelled: "запрос отменён", demand_return: "по чеку был возврат", return_flag_restored: "возвращён в неиспользованные" };
  parts.push(section("🎟 Сертификаты", certEv.map((e) => `• ${hm(e.at)} ${escapeHtml(e.label)} — ${CERT_ACTION[e.action] ?? escapeHtml(e.action)} (${escapeHtml(e.actor)})`), certEv.length));

  // 5. Бонусы: сгорание
  const burn = await safe("Сгорание", errors, async () => {
    const { data, error } = await supabaseAdmin.from("kassa_bonus_expiry_log").select("value").gte("created_at", sinceIso).lt("created_at", untilIso).limit(5000);
    if (error) throw error;
    const rows = (data ?? []) as { value: number }[];
    return { n: rows.length, sum: rows.reduce((a, r) => a + Number(r.value), 0) };
  }, { n: 0, sum: 0 });
  parts.push(burn.n > 0 ? `<b>🔥 Бонусы — сгорание</b>${NL}• обнулено у ${burn.n} клиентов: ${Math.round(burn.sum).toLocaleString("ru-RU")} бонусов` : null);

  // 6. Сотрудники и доступы: заявки в боты, новые аккаунты
  const people = await safe("Заявки сотрудников", errors, async () => {
    const out: string[] = [];
    const { data: coach } = await supabaseAdmin.from("coach_users").select("employee_name, status, requested_at, decided_at, decided_by").or(`and(requested_at.gte.${sinceIso},requested_at.lt.${untilIso}),and(decided_at.gte.${sinceIso},decided_at.lt.${untilIso})`).limit(50);
    for (const c of (coach ?? []) as { employee_name: string; status: string; decided_by: string | null }[]) out.push(`• бот-помощник: ${escapeHtml(c.employee_name)} — ${c.status === "pending" ? "новая заявка" : c.status === "approved" ? "подтверждён" : escapeHtml(c.status)}${c.decided_by ? ` (${escapeHtml(c.decided_by)})` : ""}`);
    const { data: smm } = await supabaseAdmin.from("smm_users").select("name, role, status, requested_at, decided_at, decided_by").or(`and(requested_at.gte.${sinceIso},requested_at.lt.${untilIso}),and(decided_at.gte.${sinceIso},decided_at.lt.${untilIso})`).limit(50);
    for (const c of (smm ?? []) as { name: string; role: string; status: string; decided_by: string | null }[]) out.push(`• бот СММ: ${escapeHtml(c.name)} (${escapeHtml(c.role)}) — ${c.status === "pending" ? "новая заявка" : c.status === "approved" ? "подтверждён" : escapeHtml(c.status)}${c.decided_by ? ` (${escapeHtml(c.decided_by)})` : ""}`);
    const list = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 200 });
    for (const u of list.data?.users ?? []) if (u.created_at >= sinceIso && u.created_at < untilIso) out.push(`• новый вход на сайт: ${escapeHtml(u.email ?? "без почты")}`);
    const { data: roles } = await supabaseAdmin.from("roles").select("name, is_personal, created_at").gte("created_at", sinceIso).lt("created_at", untilIso).eq("is_personal", false);
    for (const r of (roles ?? []) as { name: string }[]) out.push(`• новая роль доступа: ${escapeHtml(r.name)}`);
    return out;
  }, [] as string[]);
  parts.push(section("👥 Сотрудники и доступ", people, people.length));

  // 7. Таргет и подписчики бота клиентов
  const target = await safe("Таргет", errors, async () => {
    const { data, error } = await supabaseAdmin.from("smm_target_posts").select("city, started_at, ended_at, is_active").or(`and(started_at.gte.${sinceIso},started_at.lt.${untilIso}),and(ended_at.gte.${sinceIso},ended_at.lt.${untilIso})`).limit(200);
    if (error) throw error;
    const rows = (data ?? []) as { city: string; started_at: string; ended_at: string | null }[];
    const inWin = (v: string | null) => !!v && v >= sinceIso && v < untilIso;
    const by = (city: string, f: (r: { started_at: string; ended_at: string | null }) => boolean) => rows.filter((r) => r.city === city && f(r)).length;
    return ["aktau", "aktobe"].flatMap((c) => {
      const started = by(c, (r) => inWin(r.started_at));
      const ended = by(c, (r) => inWin(r.ended_at));
      return started + ended > 0 ? [`• ${c === "aktau" ? "Актау" : "Актобе"}: запущено ${started}, выключено ${ended}`] : [];
    });
  }, [] as string[]);
  parts.push(section("🎯 Таргет", target));
  const subs = await safe("Подписчики", errors, async () => {
    const { count } = await supabaseAdmin.from("client_bot_subscribers").select("telegram_user_id", { count: "exact", head: true }).gte("created_at", sinceIso).lt("created_at", untilIso);
    return count ?? 0;
  }, 0);
  parts.push(subs > 0 ? `<b>🤖 Бот для клиентов</b>${NL}• новых подписчиков: ${subs}` : null);

  // 8. Сбои и задержанные отчёты
  const sys = await safe("Система", errors, async () => {
    const out: string[] = [];
    const { data: st } = await supabaseAdmin.from("moysklad_sync_state").select("last_status, last_error, consecutive_failures").limit(1).maybeSingle();
    if (st && st.last_status && st.last_status !== "ok") out.push(`• синхронизация МойСклад: ${escapeHtml(String(st.last_status))}${st.last_error ? ` — ${escapeHtml(String(st.last_error).slice(0, 80))}` : ""}`);
    const { data: holds } = await supabaseAdmin.from("report_holds").select("check_date, store, status, reason, created_at, released_at").or(`and(created_at.gte.${sinceIso},created_at.lt.${untilIso}),and(released_at.gte.${sinceIso},released_at.lt.${untilIso})`).limit(50);
    for (const h of (holds ?? []) as { check_date: string; store: string; status: string; reason: string | null; released_at: string | null }[]) out.push(`• отчёты ${h.store === "point_3" ? "Актобе" : h.store === "point_1" ? "Актау" : "общие"} за ${ruDate(h.check_date)}: ${h.released_at ? "выпущены" : "задержаны"}${h.reason ? ` (${escapeHtml(h.reason.slice(0, 70))})` : ""}`);
    return out;
  }, [] as string[]);
  parts.push(section("⚙️ Система", sys));

  const real = parts.filter((p): p is string => !!p);
  const head = `🗒 <b>Что изменилось за сутки</b>${NL}${dm(sinceIso)} ${hm(sinceIso)} – ${dm(untilIso)} ${hm(untilIso)}`;
  if (real.length === 0) return { messages: [`${head}${NL}${NL}Изменений не было.`], empty: true, errors };
  const tail = errors.length ? `<i>Не удалось прочитать: ${escapeHtml(errors.join("; ").slice(0, 200))}</i>` : null;
  return { messages: packSections([head, ...real, ...(tail ? [tail] : [])]), empty: false, errors };
}
