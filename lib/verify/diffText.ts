// Понятный текст «что и на что поменяли» по записи журнала МойСклад (поле diff: у каждого поля oldValue — было, newValue — стало).
// Нужен трём сообщениям владельцу: «чеки и возвраты задним числом», «товары, склад, документы» и ночная сводка (решение владельца 14.11.2026:
// «все изменения я должен видеть, что и на что менялось, и каким оно было ранее»). Возвращает обычный текст — экранирует вызывающий.
import { trim2Ru } from "@/lib/numFormat";

type Obj = Record<string, unknown>;
type Pair = { oldValue?: unknown; newValue?: unknown };
export type DiffCtx = { label: (key: string) => string; person: (login: unknown) => string };

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const rub = (n: number) => `${trim2Ru(n)} ₸`;
const MONEY_FIELDS = new Set(["sum", "cashSum", "noCashSum"]);
const MAX_ITEMS = 8; // позиций и пунктов списка в одном поле
const MAX_LINES = 14; // строк на одну запись

// [число, валюта]: цены товара и доп. поля-цены; валюта — строка («тенге») или объект с name
function priceText(v: unknown): string | null {
  if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== "number") return null;
  const cur = typeof v[1] === "string" ? v[1] : isObj(v[1]) ? String(v[1].name ?? "") : "";
  return `${trim2Ru(v[0])} ${cur === "" || cur === "тенге" ? "₸" : cur}`;
}

function scalar(key: string, v: unknown, ctx: DiffCtx): string {
  if (v === null || v === undefined) return "—";
  const price = priceText(v);
  if (price) return price;
  if (typeof v === "boolean") return v ? "да" : "нет";
  if (typeof v === "number") return MONEY_FIELDS.has(key) ? rub(v) : trim2Ru(v);
  if (typeof v === "string") {
    if (v === "") return "пусто";
    if (key === "owner") return ctx.person(v);
    const d = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(v);
    if (d) return `${d[3]}.${d[2]}.${d[1]} ${d[4]}:${d[5]}`;
    return `«${v.length > 90 ? `${v.slice(0, 90)}…` : v}»`;
  }
  if (isObj(v) && typeof v.name === "string") return v.name;
  if (Array.isArray(v)) return v.map((x) => scalar(key, x, ctx)).join(", ");
  return "…";
}

// Позиция документа: товар · количество · цена (· скидка)
function positionText(v: unknown): string {
  if (!isObj(v)) return "—";
  const a = isObj(v.assortment) ? v.assortment : {};
  const name = typeof a.name === "string" ? a.name : "товар";
  const qty = typeof v.quantity === "number" ? ` · ${trim2Ru(v.quantity)} шт` : "";
  const price = typeof v.price === "number" ? ` · ${rub(v.price)}` : "";
  const disc = typeof v.discount === "number" && v.discount > 0 ? ` · скидка ${trim2Ru(v.discount)}%` : "";
  return `${name}${qty}${price}${disc}`;
}

// Пункт списка (товар в группе, картинка, шаблон печати): строка, объект с названием или с name/enabled
function itemText(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (isObj(v) && typeof v.name === "string") return `${v.name}${v.enabled === false ? " (выкл.)" : ""}`;
  return "…";
}

// «− убрано», «+ добавлено», «было → стало» по списку пар
function listLines(key: string, items: Pair[]): string[] {
  const show = key === "positions" ? positionText : itemText;
  const removed = items.filter((x) => "oldValue" in x && !("newValue" in x)).length;
  const added = items.filter((x) => "newValue" in x && !("oldValue" in x)).length;
  const changed = items.length - removed - added;
  const lines: string[] = [];
  if (items.length > MAX_ITEMS) lines.push(`убрано ${removed}, добавлено ${added}${changed > 0 ? `, изменено ${changed}` : ""}`);
  for (const x of items.slice(0, MAX_ITEMS)) {
    const hasOld = "oldValue" in x;
    const hasNew = "newValue" in x;
    if (hasOld && hasNew) lines.push(`было: ${show(x.oldValue)}`, `стало: ${show(x.newValue)}`);
    else if (hasOld) lines.push(`− ${show(x.oldValue)}`);
    else if (hasNew) lines.push(`+ ${show(x.newValue)}`);
  }
  if (items.length > MAX_ITEMS) lines.push(`…и ещё ${items.length - MAX_ITEMS}`);
  return lines;
}

// Строки «поле: было → стало» по diff записи
export function describeDiff(diff: unknown, ctx: DiffCtx): string[] {
  if (!isObj(diff)) return [];
  const out: string[] = [];
  for (const k of Object.keys(diff)) {
    if (k === "mainImage" && "image" in diff) continue; // то же фото показано в «image»
    const v = diff[k];
    const label = ctx.label(k);
    if (Array.isArray(v) && v.length > 0 && v.every((x) => isObj(x) && ("oldValue" in x || "newValue" in x))) {
      out.push(`${label}:`, ...listLines(k, v as Pair[]).map((l) => `  ${l}`));
    } else if (isObj(v) && ("oldValue" in v || "newValue" in v)) {
      out.push(`${label}: ${scalar(k, v.oldValue, ctx)} → ${scalar(k, v.newValue, ctx)}`);
    } else {
      out.push(`${label}: изменено`);
    }
  }
  return out.length > MAX_LINES ? [...out.slice(0, MAX_LINES), `…и ещё ${out.length - MAX_LINES}`] : out;
}

// Время МойСклад («ГГГГ-ММ-ДД ЧЧ:ММ:СС», на 2 часа раньше Алматы) → «ДД.ММ ЧЧ:ММ» по Алматы
function almatyLabel(atMs: string | null): string {
  if (!atMs) return "";
  const d = new Date(`${atMs.replace(" ", "T").slice(0, 19)}Z`);
  if (Number.isNaN(d.getTime())) return "";
  d.setUTCHours(d.getUTCHours() + 2);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// Описание одной правки целиком: что за документ, кто и когда менял, что именно поменялось
export function describeChange(
  r: { kind: string; name: string; docDate: string | null; info: string | null; eventType: string; who: string; atMs: string | null; diff: unknown },
  ctx: DiffCtx
): string {
  const isDoc = r.kind === "чек" || r.kind === "возврат";
  const title = isDoc ? `${r.kind} ${r.name}` : `${r.kind}${r.name ? ` «${r.name.slice(0, 70)}»` : ""}`;
  const date = r.docDate ? ` от ${r.docDate.slice(8, 10)}.${r.docDate.slice(5, 7)}` : "";
  // «от 2026-11-08 18:20:00 Дубраев Нургиса 89700.0 тенге» → «Дубраев Нургиса, 89 700 ₸»
  const tail = (r.info ?? "").replace(/^от \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s*/, "").trim();
  const m = /^(.*?)\s*([\d.]+) тенге$/.exec(tail);
  const info = m ? [m[1], rub(Number(m[2]))].filter(Boolean).join(", ") : tail.slice(0, 60);
  const verb = r.eventType === "delete" ? "удалён" : r.eventType === "create" ? "создан" : "изменён";
  const when = almatyLabel(r.atMs);
  const lines = [`${title}${date}${info ? ` · ${info}` : ""} — ${verb}`, `   ${r.who}${when ? `, ${when}` : ""}`];
  if (r.eventType === "update") {
    const d = describeDiff(r.diff, ctx);
    lines.push(...(d.length > 0 ? d.map((l) => `   ${l}`) : ["   (в журнале нет подробностей, что именно изменено)"]));
  }
  return lines.join("\n");
}
