// Сообщение главному владельцу в личку бота-помощника (результаты сверки, задержанные отчёты).
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { telegramTransport, type ReplyMarkup } from "@/lib/coach/bot";
import { getErrorMessage } from "@/lib/errors";

export async function notifyOwner(html: string, markup?: ReplyMarkup): Promise<void> {
  try {
    const { data: owner } = await supabaseAdmin
      .from("coach_users")
      .select("telegram_chat_id")
      .eq("is_protected", true)
      .eq("status", "approved")
      .maybeSingle();
    if (owner) await telegramTransport.send(owner.telegram_chat_id, html, markup);
  } catch (e) {
    console.error("notifyOwner error:", getErrorMessage(e));
  }
}
