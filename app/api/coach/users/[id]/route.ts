import { NextResponse } from "next/server";
import { requireSectionAccess } from "@/lib/requireAdmin";
import { telegramTransport } from "@/lib/coach/bot";
import { COACH_ACTIONS, decideCoachUser, type CoachAction } from "@/lib/coach/decisions";

// Решение владельца по стилисту-консультанту из «Настройки → Помощник консультантов»:
// подтвердить заявку, отклонить, отключить подтверждённого, включить обратно,
// убрать из системы. Человеку в Telegram сразу уходит сообщение об этом.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const caller = await requireSectionAccess(request, "settings.coach", "edit");
  if (!caller) return NextResponse.json({ error: "Нет доступа." }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as { action?: CoachAction };
  const action = body.action;
  if (!action || !COACH_ACTIONS.includes(action)) return NextResponse.json({ error: "Неизвестное действие." }, { status: 400 });

  const result = await decideCoachUser(Number(params.id), action, caller.user.email ?? caller.user.id, telegramTransport);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.code });
  return NextResponse.json({ ok: true, status: result.status, notified: result.notified });
}
