// План продаж для стилиста-консультанта: кнопка «План» и вопрос после утренних итогов смены.
// Период: на сегодня, на завтра, эта неделя (пн–вс), до конца недели (с сегодняшним днём).
// План — личный (по плану самого сотрудника) или общий (план оборота города). Расчёт дня — по долям дней недели (lib/dayPlan),
// тот же, что на портале и в других сообщениях бота.
import { type ReplyMarkup, type Transport } from "@/lib/coach/bot";
import { addDays, employeeDayPlans, loadEmployeeDays, mondayOf, shortDate, todayInAlmaty, type EmployeeRef } from "@/lib/coach/metrics";
import { loadPeriod } from "@/lib/reports/weeklyCompare";
import { money, num, pre } from "@/lib/reports/sales";

const CITY: Record<string, string> = { point_1: "Актау", point_3: "Актобе" };
const WEEKDAY = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const NL = String.fromCharCode(10);

type Code = "t" | "m" | "w" | "r"; // сегодня, завтра, неделя, до конца недели
type Kind = "o" | "l"; // общий, личный
const CODE_LABEL: Record<Code, string> = { t: "на сегодня", m: "на завтра", w: "на эту неделю", r: "до конца недели (с сегодняшним днём)" };

export const PLAN_BUTTON = "План";

export const PLAN_ASK_TEXT = "Нужен ли вам план продаж на сегодня?";
export const PLAN_ASK_MARKUP: ReplyMarkup = {
  inline_keyboard: [[{ text: "✅ Да, показать", callback_data: "pl:p:t" }, { text: "Нет, спасибо", callback_data: "pl:n" }]],
};

function dayLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return `${WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${shortDate(date)}`;
}

function rangeOf(code: Code, today: string): { from: string; to: string } {
  if (code === "t") return { from: today, to: today };
  if (code === "m") return { from: addDays(today, 1), to: addDays(today, 1) };
  const monday = mondayOf(today);
  if (code === "w") return { from: monday, to: addDays(monday, 6) };
  return { from: today, to: addDays(monday, 6) };
}

// Меню периодов («План» в меню стилиста).
export async function sendPlanMenu(t: Transport, chatId: number | string) {
  await t.send(chatId, "📅 <b>План продаж</b>" + NL + "На какой период показать?", {
    inline_keyboard: [
      [{ text: "На сегодня", callback_data: "pl:p:t" }, { text: "На завтра", callback_data: "pl:p:m" }],
      [{ text: "Эта неделя", callback_data: "pl:p:w" }],
      [{ text: "До конца недели (с сегодня)", callback_data: "pl:p:r" }],
    ],
  });
}

type Row = { date: string; plan: number | null; fact: number | null };

async function loadRows(emp: EmployeeRef, kind: Kind, from: string, to: string, today: string): Promise<Row[]> {
  const yesterday = addDays(today, -1);
  if (kind === "l") {
    const plans = await employeeDayPlans(emp, from, to);
    const facts = new Map<string, number>();
    if (from <= yesterday) for (const d of await loadEmployeeDays(emp.id, from, to < yesterday ? to : yesterday)) facts.set(d.date, d.revenue);
    return plans.map((p) => ({ date: p.date, plan: p.plan, fact: p.date < today ? (facts.get(p.date) ?? 0) : null }));
  }
  const w = await loadPeriod(emp.store, from, to, false);
  return w.days.map((d) => ({ date: d.date, plan: d.planRevenue, fact: d.date < today ? d.revenue : null }));
}

const pctText = (fact: number, plan: number) => (plan > 0 ? `${Math.round((fact / plan) * 100)}%` : "—");

export async function buildPlanMessage(emp: EmployeeRef, code: Code, kind: Kind, today = todayInAlmaty()): Promise<string> {
  const { from, to } = rangeOf(code, today);
  const rows = await loadRows(emp, kind, from, to, today);
  const city = CITY[emp.store] ?? emp.store;
  const head = `📅 <b>План ${CODE_LABEL[code]}</b>${NL}${kind === "l" ? `Личный план · ${emp.name}` : `Общий план · ${city}`}`;
  if (rows.every((r) => r.plan === null)) {
    return `${head}${NL}${NL}Личный план на этот месяц руководитель пока не внёс — как только он появится, здесь будут ваши цифры.`;
  }
  const dated = (r: Row) => r.plan ?? 0;
  if (rows.length === 1) {
    const r = rows[0];
    const lines = [dayLabel(r.date), `План дня ${money(dated(r))}`];
    return `${head}${NL}${pre(lines.join(NL))}${NL}Факт обновляется ночью — итоги дня придут утром.`;
  }
  const lines = [`${"день".padEnd(9)}${"план".padStart(11)}${"факт".padStart(11)}${"%".padStart(6)}`];
  for (const r of rows) {
    lines.push(`${dayLabel(r.date).padEnd(9)}${num(dated(r)).padStart(11)}${(r.fact === null ? "—" : num(r.fact)).padStart(11)}${(r.fact === null ? "" : pctText(r.fact, dated(r))).padStart(6)}`);
  }
  const planAll = rows.reduce((a, r) => a + dated(r), 0);
  const past = rows.filter((r) => r.fact !== null);
  lines.push("─".repeat(37), `План ${CODE_LABEL[code] === CODE_LABEL.w ? "недели" : "периода"} ${money(planAll)}`);
  if (past.length > 0) {
    const planPast = past.reduce((a, r) => a + dated(r), 0);
    const fact = past.reduce((a, r) => a + (r.fact ?? 0), 0);
    lines.push(`План за прошедшие дни ${money(planPast)}`, `Факт ${money(fact)}`, `Выполнение ${pctText(fact, planPast)}`);
  }
  const future = rows.filter((r) => r.fact === null);
  if (future.length > 0) {
    const planLeft = future.reduce((a, r) => a + dated(r), 0);
    lines.push(`Впереди (${future.length} дн.) ${money(planLeft)}`);
  }
  return `${head}${NL}${pre(lines.join(NL))}`;
}

// Нажатия pl:… — pl:p:<период> (выбрали период → спросить вид плана), pl:r:<период>:<o|l> (показать), pl:n (не нужен).
export async function handlePlanCallback(
  data: string,
  t: Transport,
  chatId: number | string,
  emp: EmployeeRef,
  dropCurrent: () => Promise<void>
): Promise<void> {
  const [, action, a, b] = data.split(":");
  if (action === "n") {
    await dropCurrent();
    return;
  }
  if (action === "p" && (a === "t" || a === "m" || a === "w" || a === "r")) {
    await dropCurrent();
    await t.send(chatId, `📅 <b>План ${CODE_LABEL[a]}</b>${NL}Какой план показать?`, {
      inline_keyboard: [
        [{ text: "👤 Личный план", callback_data: `pl:r:${a}:l` }],
        [{ text: `🏙 Общий план города (${CITY[emp.store] ?? emp.store})`, callback_data: `pl:r:${a}:o` }],
      ],
    });
    return;
  }
  if (action === "r" && (a === "t" || a === "m" || a === "w" || a === "r") && (b === "o" || b === "l")) {
    await dropCurrent();
    try {
      await t.send(chatId, await buildPlanMessage(emp, a, b), { inline_keyboard: [[{ text: "← Другой план", callback_data: "pl:m" }]] });
    } catch (e) {
      await t.send(chatId, `Не удалось собрать план: ${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }
  if (action === "m") {
    await dropCurrent();
    await sendPlanMenu(t, chatId);
  }
}
