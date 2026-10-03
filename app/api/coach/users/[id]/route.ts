import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireSectionAccess } from "@/lib/requireAdmin";
import { getErrorMessage } from "@/lib/errors";
import { MENU_MARKUP, REMOVE_KEYBOARD, telegramTransport } from "@/lib/coach/bot";

type Action = "approve" | "reject" | "disable" | "enable";

const NEXT_STATUS: Record<Action, { from: string[]; to: string }> = {
  approve: { from: ["pending"], to: "approved" },
  reject: { from: ["pending"], to: "rejected" },
  disable: { from: ["approved"], to: "disabled" },
  enable: { from: ["disabled", "rejected"], to: "approved" },
};

const NOTICE: Record<Action, { text: string; markup?: Record<string, unknown> }> = {
  approve: { text: "✅ Руководитель подтвердил ваш доступ. Выберите раздел кнопкой внизу.", markup: MENU_MARKUP },
  enable: { text: "✅ Доступ к боту снова включён. Выберите раздел кнопкой внизу.", markup: MENU_MARKUP },
  reject: { text: "Заявку отклонили. Если это ошибка, нажмите /start и отправьте её заново или обратитесь к руководителю.", markup: REMOVE_KEYBOARD },
  disable: { text: "Доступ к боту отключён. Обратитесь к руководителю.", markup: REMOVE_KEYBOARD },
};

// Решение владельца по продавцу из «Настройки → Помощник консультантов»:
// подтвердить заявку, отклонить, отключить подтверждённого, включить обратно.
// Человеку в Telegram сразу уходит сообщение об этом.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const caller = await requireSectionAccess(request, "settings.coach", "edit");
  if (!caller) return NextResponse.json({ error: "Нет доступа." }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as { action?: Action };
  const action = body.action;
  if (!action || !(action in NEXT_STATUS)) return NextResponse.json({ error: "Неизвестное действие." }, { status: 400 });

  const { data: user, error: fetchError } = await supabaseAdmin.from("coach_users").select("*").eq("id", params.id).maybeSingle();
  if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 400 });
  if (!user) return NextResponse.json({ error: "Заявка не найдена." }, { status: 404 });

  const rule = NEXT_STATUS[action];
  if (!rule.from.includes(user.status)) {
    return NextResponse.json({ error: "Статус уже изменился — обновите страницу." }, { status: 409 });
  }

  const { error: updateError } = await supabaseAdmin
    .from("coach_users")
    .update({ status: rule.to, decided_at: new Date().toISOString(), decided_by: caller.user.email ?? caller.user.id })
    .eq("id", user.id);
  if (updateError) {
    const taken = /coach_users_employee_active|duplicate/i.test(updateError.message);
    return NextResponse.json(
      { error: taken ? "Этот сотрудник уже привязан к другому Telegram-аккаунту." : updateError.message },
      { status: taken ? 409 : 400 }
    );
  }

  let notified = true;
  try {
    await telegramTransport.send(user.telegram_chat_id, NOTICE[action].text, NOTICE[action].markup);
  } catch (e) {
    notified = false;
    console.error("coach notice error:", getErrorMessage(e));
  }
  return NextResponse.json({ ok: true, status: rule.to, notified });
}
