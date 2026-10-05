// Тексты бота-помощника для продавцов. Цифры — в блоках <pre> с пустой первой
// строкой (общее правило оформления отчётов, функция pre из lib/reports/sales).
import { escapeHtml } from "@/lib/telegram";
import { money, num, pre } from "@/lib/reports/sales";
import {
  type Advice,
  type DayRow,
  type EmployeeRef,
  type MonthStatus,
  type PerShift,
  type WeekSummary,
  MAX_AVG_CHECK_GROWTH,
  closePlanScenarios,
  shortDate,
} from "@/lib/coach/metrics";

const MONTHS = [
  "январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
];

function line(label: string, value: string): string {
  return `${label.padEnd(20)}${value.padStart(12)}`;
}
function pct(n: number): string {
  return `${n.toFixed(2)}%`;
}
function monthTitle(date: string): string {
  return `${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

export const NO_PLAN_TEXT =
  "План на этот месяц руководитель пока не внёс — как только он появится, здесь будут ваши цифры.";

export const HELP_MENU_TEXT = "Чем помочь? Выберите раздел:";

export const SUPPORT_TEXT = [
  "<b>Поддержка</b>",
  "",
  "Если что-то работает не так, цифры вызывают вопросы или нужно сменить профиль — напишите: @ab1lov3",
].join("\n");

export const ADMIN_HELP_TEXT = [
  "<b>Обучение: как пользоваться ботом</b>",
  "",
  "Кнопки внизу:",
  "• <b>Заявки</b> — кто хочет войти в систему. Нажмите на имя, затем «Принять» или «Отказать».",
  "• <b>Сотрудники</b> — все стилисты-консультанты со статусами. В карточке видно, как идёт их месяц (план/факт), и можно отключить, включить или убрать сотрудника.",
  "• <b>Продажи</b> — сначала выбор: «по сотрудникам» (выручка, чеки, средний чек каждого стилиста, за месяц — выполнение плана) или «по городу» (общая касса города: итоги, способы оплаты, возвраты, трафик). Период — вчера, последние 7 дней, месяц или свой (например 01.10-15.10).",
  "• <b>Помощь</b> — это меню.",
  "",
  "Роли: владелец, администратор и стилист-консультант. Администратор видит продажи только своего города, владелец — всех городов.",
  "",
  "Когда кто-то выбирает себя в боте, вам сразу приходит сообщение с кнопками «Принять» и «Отказать». Решение остаётся в истории чата, сотруднику уходит сообщение.",
].join("\n");

// Владелец, но не главный: смотрит сотрудников и продажи всех городов, решения принимает главный владелец.
export const OWNER_VIEW_HELP_TEXT = [
  "<b>Обучение: как пользоваться ботом</b>",
  "",
  "Кнопки внизу:",
  "• <b>Сотрудники</b> — все стилисты-консультанты со статусами и планом/фактом месяца (только просмотр).",
  "• <b>Продажи</b> — «по сотрудникам» или «по городу» (общая касса) для любого города или всех сразу: вчера, последние 7 дней, месяц или свой период (например 01.10-15.10).",
  "• <b>Помощь</b> — это меню.",
  "• <b>Выход</b> — отвязать этот Telegram от вашего профиля; чтобы вернуться, пройдите регистрацию заново.",
  "",
  "Принимать заявки, отключать сотрудников и менять роли может только главный владелец.",
].join("\n");

export const CITY_ADMIN_HELP_TEXT = [
  "<b>Обучение: как пользоваться ботом</b>",
  "",
  "Кнопки внизу:",
  "• <b>Продажи</b> — вашего города «по сотрудникам» или «по городу» (общая касса) за вчера, последние 7 дней, месяц или свой период (например 01.10-15.10): выручка, чеки, средний чек, а за месяц ещё и выполнение плана.",
  "• <b>Помощь</b> — это меню.",
  "• <b>Выход</b> — отвязать этот Telegram от вашего профиля; чтобы вернуться, пройдите регистрацию заново.",
  "",
  "Заявки и сотрудников подтверждает главный владелец.",
].join("\n");

export const HELP_TEXT = [
  "<b>Обучение: как работает бот</b>",
  "",
  "Смотреть план и продажи кнопками не нужно — бот сам присылает вам сообщения:",
  "• <b>утром после смены</b> — итоги вашей смены (выручка, чеки, средний чек, глубина чека), как идёт месяц, сколько нужно в среднем за смену и что повысить в первую очередь. Если вчера у вас не было продаж, сообщения не будет;",
  "• <b>каждый понедельник утром</b> — цель на новую неделю и три способа её закрыть (больше чеков по вашему среднему чеку, меньше чеков с более высоким средним чеком или понемногу того и другого), а также итоги прошлой недели: план, факт, чеки, средний чек, глубина чека.",
  "",
  "Факт обновляется ночью, поэтому сегодняшние продажи появятся завтра.",
  "",
  "Кнопки внизу:",
  "• <b>Помощь</b> — это меню: обучение (то, что вы читаете) и поддержка.",
  "• <b>Выход</b> — отвязать этот Telegram от вашего профиля. Чтобы вернуться, нужно заново пройти регистрацию и дождаться подтверждения руководителя.",
].join("\n");

// Ответ, если стилист пишет боту что-то кроме «Помощь» / «Выход»: сам бот ничего по запросу не показывает.
export const AUTO_ONLY_TEXT =
  "Бот сам присылает сообщения: утром после вашей смены и по понедельникам — план на неделю и итоги прошлой. Если нужна помощь, нажмите «Помощь».";

export function myPlanMessage(emp: EmployeeRef, s: MonthStatus): string {
  const head = `📌 <b>Мой план — ${monthTitle(s.today)}</b>\n${escapeHtml(emp.name)}`;
  if (s.plan === null) return `${head}\n${pre(line("Факт (по вчера)", money(s.fact)))}\n${NO_PLAN_TEXT}`;
  const rows = [
    line("План на месяц", money(s.plan)),
    line("Факт (по вчера)", money(s.fact)),
    line("Выполнение", s.pct !== null ? pct(s.pct) : "—"),
    line("Осталось закрыть", money(s.deficit)),
    line("Смен впереди (≈)", num(s.remainingShifts)),
    line("Нужно в ср. за смену", s.needPerShift !== null ? money(s.needPerShift) : "—"),
  ];
  let text = `${head}\n${pre(rows.join("\n"))}`;
  if (s.deficit <= 0) text += "\n✅ План месяца уже закрыт — отличная работа!";
  if (s.period) {
    const p = s.period;
    text += `\n\n<b>Текущий период ${shortDate(p.from)}–${shortDate(p.to)}</b> (${p.percent}% плана)\n${pre(
      [
        line("План периода", money(p.plan)),
        line("Факт периода", money(p.fact)),
        line("Нужно в ср. за смену", p.needPerShift !== null ? money(p.needPerShift) : "—"),
      ].join("\n")
    )}`;
  }
  return text;
}

const LAGGING_LABEL: Record<NonNullable<Advice["lagging"]>, string> = {
  receipts: "количество чеков в среднем за смену",
  avgCheck: "средний чек",
  depth: "глубина чека (товаров в одном чеке)",
};

const LAGGING_TIP: Record<NonNullable<Advice["lagging"]>, string> = {
  receipts: "Больше обращайтесь к зашедшим в зал, предлагайте примерить, не пропускайте покупателей.",
  avgCheck: "Предлагайте более дорогие модели и комплекты, показывайте топовые позиции.",
  depth: "К каждому товару предлагайте второй: рубашка + брюки, куртка + аксессуар, второй цвет.",
};

export function adviceMessage(emp: EmployeeRef, s: MonthStatus, a: Advice): string {
  const head = `💡 <b>Что повысить</b>\n${escapeHtml(emp.name)}`;
  if (a.noPlan) return `${head}\n\n${NO_PLAN_TEXT}`;
  if (a.closed) return `${head}\n\n✅ План месяца уже закрыт. Держите темп — всё, что сверх плана, идёт в запас.`;
  if (a.noHistory || a.factor === null || !s.perShift) {
    return `${head}\n\nПока мало данных по вашим сменам за последние 4 недели — рекомендации появятся после нескольких смен.`;
  }
  const rows = a.rows.map((r) => `${r.label}\n  в среднем за смену ${r.now}${r.recent ? `\n  за последние 7 дней ${r.recent}` : ""}`);
  const lines: string[] = [
    head,
    "",
    scenariosText(s.perShift, a.needPerShift ?? 0),
    "",
    "<b>Ваши показатели сейчас:</b>",
    pre(rows.join("\n")),
  ];
  if (a.lagging) {
    lines.push(
      a.laggingRatio !== null && a.laggingRatio < 1
        ? `Сильнее всего просел относительно вашего же среднего: <b>${LAGGING_LABEL[a.lagging]}</b>.`
        : `Медленнее всего растёт относительно вашего же среднего: <b>${LAGGING_LABEL[a.lagging]}</b>.`
    );
    lines.push(LAGGING_TIP[a.lagging]);
  }
  return lines.join("\n");
}

// Три способа закрыть план (или цель недели): тот же результат можно получить
// большим количеством чеков по привычному среднему чеку, меньшим количеством чеков
// при более высоком среднем чеке или понемногу тем и другим. need — выручка за смену, которая нужна.
function scenariosText(own: PerShift, need: number): string {
  if (need <= own.revenue) {
    return `✅ По вашему обычному темпу (${money(own.revenue)} за смену в среднем) это закрывается — нужно ${money(need)}. Держите количество чеков (${own.receipts.toFixed(1)}) и средний чек (${money(own.avgCheck)}).`;
  }
  const s = closePlanScenarios(own, need);
  const up = (r: number) => `+${Math.round((r - 1) * 100)}%`;
  const maxPct = Math.round((MAX_AVG_CHECK_GROWTH - 1) * 100);
  const r = s.raiseCheck;
  const b = s.balanced;
  const capped = s.growth > MAX_AVG_CHECK_GROWTH; // даже с максимальным ростом среднего чека одним чеком не обойтись
  return [
    `<b>Нужно в среднем ${money(need)} за смену</b> — сейчас вы делаете ${money(own.revenue)} (рост в ${s.growth.toFixed(2)} раза). Выручка за смену = чеки × средний чек, поэтому закрыть можно по-разному:`,
    "",
    `<b>1️⃣ По вашему среднему чеку (${money(own.avgCheck)})</b>\nНужно больше чеков: <b>${s.sameCheck.receipts.toFixed(1)}</b> за смену вместо ${own.receipts.toFixed(1)} (${up(s.growth)}).`,
    "",
    `<b>2️⃣ Поднять средний чек${capped ? ` на максимум ${maxPct}%` : ""}</b>\nСредний чек <b>${money(Math.round(r.avgCheck))}</b> вместо ${money(own.avgCheck)} (${up(r.checkGrowth)}), ` +
      `чеков ${capped ? `<b>${r.receipts.toFixed(1)}</b> вместо ${own.receipts.toFixed(1)} (${up(r.receiptsGrowth)})` : `столько же (${own.receipts.toFixed(1)})`}. ` +
      `Для этого в чеке нужно ≈ ${r.depth.toFixed(2)} товара вместо ${own.depth.toFixed(2)} или более дорогие модели. Так чеков нужно меньше всего.`,
    "",
    `<b>3️⃣ Понемногу и то и другое</b>\nСредний чек ${money(Math.round(b.avgCheck))} (${up(b.checkGrowth)}) и ${b.receipts.toFixed(1)} чека за смену (${up(b.receiptsGrowth)}).`,
    "",
    `Средний чек можно поднять не больше чем на ${maxPct}%, остальное добирается количеством чеков.`,
  ].join("\n");
}

function weekLines(w: WeekSummary): { last: string; next: string } {
  const l = w.lastWeek;
  const period = `${shortDate(l.from)}–${shortDate(l.to)}`;
  // Факт показываем всегда, план — как сравнение, если он был внесён.
  const factRows =
    l.shifts > 0
      ? [
          line("Выручка", money(l.fact)),
          line("Смен", num(l.shifts)),
          line("Чеков", num(l.receipts)),
          line("Средний чек", l.receipts > 0 ? money(l.fact / l.receipts) : "—"),
          line("Глубина чека", l.receipts > 0 ? (l.items / l.receipts).toFixed(2) : "—"),
        ]
      : [];
  const planRow = line("План недели", l.plan === null ? "не внесён" : money(l.plan));
  const doneRow = l.plan !== null && l.plan > 0 ? [line("Выполнение", pct((l.fact / l.plan) * 100))] : [];
  let last: string;
  if (l.shifts === 0 && l.plan === null) {
    last = `Прошлая неделя (${period}): смен с продажами не было, план не внесён.`;
  } else if (l.plan === null) {
    last = `Прошлая неделя (${period}) по факту:\n${pre([planRow, ...factRows].join("\n"))}`;
  } else if (l.shortfall <= 0) {
    last = `✅ Прошлая неделя (${period}) выполнена.\n${pre([planRow, ...(factRows.length ? factRows : [line("Выручка", money(l.fact))]), ...doneRow].join("\n"))}`;
  } else {
    last = `⚠️ Прошлая неделя (${period}) <b>не выполнена</b>.\n${pre(
      [planRow, ...(factRows.length ? factRows : [line("Выручка", money(l.fact))]), ...doneRow, line("Недобор", money(l.shortfall))].join("\n")
    )}`;
  }
  const t = w.thisWeek;
  let next: string;
  if (t.target === null || t.base === null) {
    next = NO_PLAN_TEXT;
  } else {
    const rows = [line("План недели", money(t.base))];
    if (t.extra > 0) rows.push(line("+ часть недобора", money(t.extra)));
    rows.push(line("Цель недели", money(t.target)));
    if (t.perShift !== null) rows.push(line("≈ в среднем за смену", money(t.perShift)));
    next = `🎯 <b>Цель на неделю ${shortDate(t.from)}–${shortDate(t.to)}</b>\n${pre(rows.join("\n"))}`;
    if (t.need) next += `\n\n${scenariosText(t.need.own, t.need.perShift)}\n`;
    if (t.extra > 0) {
      next += "\nНедобор прошлой недели распределён поровну на оставшиеся дни месяца, на эту неделю приходится указанная часть.";
    }
  }
  return { last, next };
}

export function weekMessage(emp: EmployeeRef, w: WeekSummary, forMonday = false): string {
  const { last, next } = weekLines(w);
  const t = w.thisWeek;
  const head = `📅 <b>${forMonday ? "Новая неделя" : "План на неделю"}</b>\n${escapeHtml(emp.name)}`;
  let text = `${head}\n\n${next}`;
  if (!forMonday && t.target !== null) {
    text += `\n${pre([line("Факт недели", money(t.factSoFar)), line("Осталось", money(t.remaining ?? 0))].join("\n"))}`;
  }
  if (forMonday) text += `\n\n${last}`;
  return text;
}

export function lastWeekMessage(emp: EmployeeRef, w: WeekSummary): string {
  return `📊 <b>Итоги прошлой недели</b>\n${escapeHtml(emp.name)}\n\n${weekLines(w).last}`;
}

export function dailyMessage(emp: EmployeeRef, date: string, day: DayRow, s: MonthStatus, a: Advice): string {
  const avgCheck = day.receipts > 0 ? day.revenue / day.receipts : 0;
  const depth = day.receipts > 0 ? day.items / day.receipts : 0;
  let text = `📊 <b>Итоги вашей смены · ${shortDate(date)}</b>\n${escapeHtml(emp.name)}\n${pre(
    [
      line("Выручка", money(day.revenue)),
      line("Чеков", num(day.receipts)),
      line("Средний чек", day.receipts > 0 ? money(avgCheck) : "—"),
      line("Глубина чека", day.receipts > 0 ? depth.toFixed(2) : "—"),
    ].join("\n")
  )}`;
  if (s.plan === null) return `${text}\n${NO_PLAN_TEXT}`;
  text += `\n<b>Месяц:</b> ${money(s.fact)} из ${money(s.plan)}${s.pct !== null ? ` (${pct(s.pct)})` : ""}`;
  if (s.deficit <= 0) return `${text}\n✅ План месяца закрыт!`;
  text += `\nОсталось закрыть ${money(s.deficit)} — это в среднем ≈ ${money(s.needPerShift ?? 0)} за смену.`;
  if (a.lagging) text += `\n💡 Что повысить в первую очередь: <b>${LAGGING_LABEL[a.lagging]}</b>. ${LAGGING_TIP[a.lagging]}`;
  return text;
}
