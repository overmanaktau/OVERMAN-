import { NextResponse } from "next/server";
import { getErrorMessage } from "@/lib/errors";
import { checkPassword, makeSession } from "@/lib/sellers/session";

export const maxDuration = 30;

// Защита от перебора пароля: после 5 неверных попыток с одного адреса — пауза на 10 минут (счётчик в памяти сервера).
const fails = new Map<string, { n: number; until: number }>();
const WINDOW_MS = 10 * 60 * 1000;

// Вход на /seller: POST {login, password} → пропуск, который страница держит только в памяти.
export async function POST(request: Request) {
  const ip = (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "?";
  const rec = fails.get(ip);
  if (rec && rec.n >= 5 && rec.until > Date.now()) return NextResponse.json({ error: "Слишком много попыток. Подождите 10 минут." }, { status: 429 });
  try {
    const body = (await request.json().catch(() => ({}))) as { login?: string; password?: string };
    const ok = typeof body.login === "string" && typeof body.password === "string" && (await checkPassword(body.login, body.password));
    if (!ok) {
      const n = rec && rec.until > Date.now() ? rec.n + 1 : 1;
      fails.set(ip, { n, until: Date.now() + WINDOW_MS });
      return NextResponse.json({ error: "Неверный логин или пароль." }, { status: 401 });
    }
    fails.delete(ip);
    return NextResponse.json({ ok: true, token: makeSession() });
  } catch (e) {
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}
