// Единое правило показа чисел в статистике — везде: сайт, PDF, Telegram (решение владельца 27.10.2026).
// Если после округления до сотых дробная часть нулевая — число показывается целым («4 028», «19»), иначе — два знака после запятой («282,15», «9,40»).

// Округление до сотых; «-0» превращается в 0.
function round2(n: number): number {
  const r = Math.round(n * 100) / 100;
  return r === 0 ? 0 : r;
}

// Без разделителя разрядов; sep — разделитель дробной части (на сайте и в сообщениях исторически где точка, где запятая — оставляем как было в каждом месте).
export function trim2(n: number, sep: "." | "," = "."): string {
  const r = round2(n);
  if (Number.isInteger(r)) return String(r);
  const s = r.toFixed(2);
  return sep === "," ? s.replace(".", ",") : s;
}

// С пробелом между разрядами и запятой («4 028», «16 364 435,53»).
export function trim2Ru(n: number): string {
  const r = round2(n);
  return Number.isInteger(r) ? r.toLocaleString("ru-RU") : r.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
