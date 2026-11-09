// Онлайн-продажи определяются по комментарию к чеку в МойСклад: продавец пишет «онлайн» (решение владельца 09.11.2026; отдельного онлайн-продавца нет).
// yes — слово начинается на «онл»/«onl»; maybe — похоже на «онлайн/online» с опечаткой («онлаин», «анлайн», «он лайн»); оба считаются онлайном.
// Признаки доставки или соцсетей без слова «онлайн» онлайном не считаются.
function lev(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

export function isOnlineComment(description: string | undefined | null): boolean {
  const text = (description ?? "").toLowerCase();
  if (!text.trim()) return false;
  const tokens = text.split(/[^a-zа-яёәіңғүұқөһ]+/i).filter(Boolean);
  const cand = [...tokens, ...tokens.slice(0, -1).map((t, i) => t + tokens[i + 1])];
  if (cand.some((t) => t.startsWith("онл") || t.startsWith("onl"))) return true;
  return cand.some((t) => t.length >= 4 && (lev(t, "онлайн") <= 2 || lev(t, "online") <= 2));
}

// Подстроки для поиска в МойСклад (фильтр description~…): ловят «онлайн», «онл», «online» и частые опечатки; точную проверку делает isOnlineComment.
export const ONLINE_SEARCH_PARTS = ["онл", "onl", "лайн", "лаин", "line", "lain"];
