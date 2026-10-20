// Как показываем имена людей везде (портал, Telegram): первая буква фамилии и полное имя — «А.Акылбек». Так имя целиком помещается в узкие колонки и кнопки.
// Имя уже в таком виде («Б.Айдана»), из одного слова или почта остаются как есть; хвосты вроде «админ 04» или «(Telegram)» сохраняются.
export function shortPerson(name: string | null | undefined): string {
  const text = (name ?? "").trim();
  if (!text || text.includes("@")) return text;
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length < 2 || /^\p{L}\./u.test(parts[0])) return text;
  return `${parts[0][0].toUpperCase()}.${parts.slice(1).join(" ")}`;
}

// Подпись «Заявитель: Абилов Акылбек» в тексте запроса → «Заявитель: А.Акылбек».
export function shortenRequester(text: string | null | undefined): string {
  return (text ?? "").replace(/(Заявитель:\s*)(.+)$/u, (_m, head: string, who: string) => `${head}${shortPerson(who)}`);
}
