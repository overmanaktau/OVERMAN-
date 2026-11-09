// Вход на /seller только по паролю, без входа в портал (решение владельца 09.11.2026).
// Хэш пароля — в таблице seller_access (миграция 122; логин там просто метка строки). После входа страница получает подписанный пропуск и держит его только в памяти:
// обновили страницу или открыли заново — пароль спрашивается снова (решение владельца 09.11.2026). Пропуск живёт 12 часов, чтобы открытая вкладка не вылетала.
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const SESSION_SECONDS = 12 * 60 * 60;

function secret(): string {
  const key = process.env.CRON_SECRET;
  if (!key) throw new Error("CRON_SECRET не задан");
  return key;
}
const sign = (exp: number) => createHmac("sha256", secret()).update(`seller:${exp}`).digest("hex");

export function makeSession(): string {
  const exp = Date.now() + SESSION_SECONDS * 1000;
  return `${exp}.${sign(exp)}`;
}

// Пропуск приходит в заголовке Authorization: Bearer <пропуск>.
export function isValidSession(authHeader: string | null): boolean {
  const token = (authHeader ?? "").replace(/^Bearer\s+/i, "");
  const [expText, mac] = token.split(".");
  const exp = Number(expText);
  if (!mac || !Number.isFinite(exp) || exp < Date.now()) return false;
  const good = Buffer.from(sign(exp));
  const given = Buffer.from(mac);
  return good.length === given.length && timingSafeEqual(good, given);
}

// «scrypt$соль$хэш» — пароль в базе открытым текстом не хранится.
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${scryptSync(password, salt, 32).toString("hex")}`;
}

// Вход только по паролю (решение владельца 09.11.2026): пароль сверяется с хэшами в seller_access, логин в форме не нужен.
export async function checkPassword(password: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin.from("seller_access").select("password_hash");
  if (error) throw error;
  let ok = false;
  for (const row of (data ?? []) as { password_hash: string }[]) {
    const [kind, salt, hash] = row.password_hash.split("$");
    if (kind !== "scrypt" || !salt || !hash) continue;
    const given = scryptSync(password, salt, 32);
    const good = Buffer.from(hash, "hex");
    if (good.length === given.length && timingSafeEqual(good, given)) ok = true;
  }
  return ok;
}
