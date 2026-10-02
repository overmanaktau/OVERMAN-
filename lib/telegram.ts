const API = "https://api.telegram.org";
const MAX_MESSAGE = 4000; // Telegram's hard limit is 4096; keep a margin for entity overhead

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Packs self-contained HTML sections (a heading, a <pre> table, ...) into as few
// messages as fit under Telegram's size limit. Sections are never split in the
// middle, so an open <pre> tag can't end up in one message and its close in the next.
export function packSections(sections: string[]): string[] {
  const messages: string[] = [];
  let current = "";
  for (const section of sections) {
    const next = current ? `${current}\n\n${section}` : section;
    if (next.length > MAX_MESSAGE && current) {
      messages.push(current);
      current = section;
    } else {
      current = next;
    }
  }
  if (current) messages.push(current);
  return messages;
}

export async function sendTelegramMessage(chatId: string, html: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN не задан.");
  const res = await fetch(`${API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // protect_content: запрет пересылки, сохранения и копирования сообщений бота.
    body: JSON.stringify({
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      protect_content: true,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(`Telegram: ${data.description ?? res.status}`);
}

export async function sendTelegramMessages(chatId: string, messages: string[]): Promise<void> {
  for (const message of messages) {
    await sendTelegramMessage(chatId, message);
    // Telegram allows ~20 messages a minute per group; a short pause keeps a
    // multi-message report well under that.
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}
