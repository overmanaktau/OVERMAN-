// Онлайн-продажи определяются по комментарию к чеку в МойСклад: продавец пишет «онлайн» (решение владельца 09.11.2026; отдельного онлайн-продавца нет).
//  · yes — слово начинается на «онл»/«onl» («онлайн», «онл», «online», «on line», «он лайн») — онлайн без вопросов;
//  · maybe — подозрение: опечатка в слове «онлайн/online» («онлаин», «olnine», «анлайн», смесь латиницы и кириллицы) или слова про соцсети и доставку
//    («инстаграм», «whatsapp», «доставка», «сайт»). По такому чеку Нуржану уходит вопрос «Это онлайн?» с кнопками ✅ / ❌ (lib/onlineCheck.ts);
//  · no — ничего похожего.
export type OnlineVerdict = "yes" | "maybe" | "no";

function lev(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

// Начала слов про соцсети, мессенджеры, доставку и сайт — это подозрение, а не уверенность.
const HINT_STARTS = ["инста", "insta", "whats", "watsap", "ватсап", "вотсап", "ватцап", "директ", "direct", "доставк", "deliver", "сайт", "website", "web", "интернет", "internet"];

export function onlineVerdict(description: string | undefined | null): OnlineVerdict {
  const text = (description ?? "").toLowerCase();
  if (!text.trim()) return "no";
  const tokens = text.split(/[^a-zа-яёәіңғүұқөһ]+/i).filter(Boolean);
  const cand = [...tokens, ...tokens.slice(0, -1).map((t, i) => t + tokens[i + 1])];
  if (cand.some((t) => t.startsWith("онл") || t.startsWith("onl"))) return "yes";
  if (cand.some((t) => t.length >= 4 && (lev(t, "онлайн") <= 2 || lev(t, "online") <= 2))) return "maybe";
  if (cand.some((t) => HINT_STARTS.some((h) => t.startsWith(h)))) return "maybe";
  return "no";
}

// Подстроки для поиска в МойСклад (фильтр description~…): ловят «онлайн», «онл», «online», частые опечатки и слова-подсказки; точную проверку делает onlineVerdict.
export const ONLINE_SEARCH_PARTS = ["онл", "onl", "лайн", "лаин", "line", "lain", "инст", "inst", "whats", "ватс", "вотс", "директ", "direct", "доставк", "deliver", "сайт", "web", "интернет"];
