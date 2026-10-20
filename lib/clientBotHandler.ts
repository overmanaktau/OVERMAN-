// Обработка сообщений бота для клиентов. Кнопок у клиента нет, кроме одной — «Поделиться номером» (нужна, чтобы привязать
// Telegram к клиенту МойСклад). Команды: /start — подписаться, /stop — отписаться. На любой другой текст бот молчит.
// Ничего о бонусах бот сам не присылает — отправка сообщений о бонусах пока не включена.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { escapeHtml } from "@/lib/telegram";
import type { ClientTransport } from "@/lib/clientBot";

export type ClientTgUpdate = {
  message?: {
    chat: { id: number; type: string };
    from?: { id: number; username?: string; first_name?: string };
    text?: string;
    contact?: { phone_number: string; user_id?: number };
  };
  my_chat_member?: { chat: { id: number; type: string }; from: { id: number }; new_chat_member: { status: string } };
};

const SHARE_MARKUP = { keyboard: [[{ text: "📱 Нөмірді бөлісу", request_contact: true }]], resize_keyboard: true, one_time_keyboard: true };
const NO_KEYBOARD = { remove_keyboard: true };

const WELCOME =
  "Сәлеметсіз бе! Бұл <b>OVERMAN</b> боты.\n\n" +
  "Төмендегі «Нөмірді бөлісу» түймесін басыңыз — сонда біз сізді танып, бонустарыңыз туралы хабарлап тұра аламыз.";

function normalizePhone(raw: string): { phone: string; digits: string } | null {
  let d = raw.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("8")) d = `7${d.slice(1)}`;
  else if (d.length === 10) d = `7${d}`;
  if (d.length < 11 || d.length > 13) return null;
  return { phone: `+${d}`, digits: d };
}

// Клиент МойСклад по номеру (по последним 10 цифрам); если таких несколько — с самой свежей покупкой. Город — по тегам.
async function findClient(digits: string) {
  const tail = digits.slice(-10);
  const { data, error } = await supabaseAdmin
    .from("kassa_clients")
    .select("ms_id, name, tags, last_demand_at")
    .ilike("phone_digits", `%${tail}%`)
    .order("last_demand_at", { ascending: false, nullsFirst: false })
    .limit(1);
  if (error) throw error;
  const c = data?.[0] as { ms_id: string; name: string; tags: string[] | null } | undefined;
  if (!c) return null;
  const tags = c.tags ?? [];
  const city = tags.includes("актобе") ? "point_3" : tags.includes("overman") ? "point_1" : null;
  return { id: c.ms_id, name: c.name, city };
}

export async function handleClientUpdate(update: ClientTgUpdate, t: ClientTransport): Promise<void> {
  // клиент заблокировал бота или вернулся
  const member = update.my_chat_member;
  if (member && member.chat.type === "private") {
    const status = member.new_chat_member.status;
    if (status === "kicked") {
      await supabaseAdmin.from("client_bot_subscribers").update({ status: "blocked", blocked_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("telegram_user_id", member.from.id);
    }
    return;
  }

  const msg = update.message;
  if (!msg || msg.chat.type !== "private" || !msg.from) return;
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const now = new Date().toISOString();

  // поделился номером
  if (msg.contact) {
    // принимаем только собственный номер клиента, не чужой контакт
    if (msg.contact.user_id !== userId) {
      await t.send(chatId, "Тек өз нөміріңізбен бөлісу керек — төмендегі «Нөмірді бөлісу» түймесін басыңыз.", SHARE_MARKUP);
      return;
    }
    const p = normalizePhone(msg.contact.phone_number);
    if (!p) {
      await t.send(chatId, "Нөмір танылмады. «Нөмірді бөлісу» түймесін қайта басыңыз.", SHARE_MARKUP);
      return;
    }
    const client = await findClient(p.digits);
    const { error } = await supabaseAdmin.from("client_bot_subscribers").upsert(
      {
        telegram_user_id: userId,
        telegram_chat_id: chatId,
        username: msg.from.username ?? null,
        first_name: msg.from.first_name ?? null,
        phone: p.phone,
        phone_digits: p.digits,
        client_ms_id: client?.id ?? null,
        client_name: client?.name ?? null,
        city: client?.city ?? null,
        status: "active",
        subscribed_at: now,
        stopped_at: null,
        blocked_at: null,
        updated_at: now,
      },
      { onConflict: "telegram_user_id" }
    );
    if (error) throw error;
    const hello = client?.name ? `, ${escapeHtml(client.name)}` : "";
    await t.send(
      chatId,
      `Рахмет${hello}! Енді OVERMAN бонустарыңыз туралы хабарлап тұрамыз.\n\nЖазылымнан бас тарту: /stop`,
      NO_KEYBOARD
    );
    return;
  }

  const text = (msg.text ?? "").trim();
  if (/^\/start(\s|@|$)/i.test(text)) {
    const { data, error } = await supabaseAdmin.from("client_bot_subscribers").select("status, phone").eq("telegram_user_id", userId).maybeSingle();
    if (error) throw error;
    if (data?.status === "active") {
      await t.send(chatId, "Сіз бұрыннан жазылғансыз. Жазылымнан бас тарту: /stop", NO_KEYBOARD);
      return;
    }
    await t.send(chatId, WELCOME, SHARE_MARKUP);
    return;
  }
  if (/^\/stop(\s|@|$)/i.test(text)) {
    const { error } = await supabaseAdmin
      .from("client_bot_subscribers")
      .update({ status: "stopped", stopped_at: now, updated_at: now })
      .eq("telegram_user_id", userId);
    if (error) throw error;
    await t.send(chatId, "Сіз жазылымнан бас тарттыңыз, енді хабарлама келмейді. Қайта жазылу: /start", NO_KEYBOARD);
  }
  // всё остальное — молчим: у бота для клиентов нет меню и кнопок
}
