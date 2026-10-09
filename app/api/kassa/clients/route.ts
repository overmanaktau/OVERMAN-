import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getErrorMessage } from "@/lib/errors";
import { requireKassa } from "@/lib/kassa/access";

export const maxDuration = 30;

// Список клиентов кассы (ночная загрузка): последние покупатели, поиск по телефону или имени.
export async function GET(request: Request) {
  const caller = await requireKassa(request, "view");
  if (!caller) return NextResponse.json({ error: "Нет доступа." }, { status: 403 });
  try {
    const q = (new URL(request.url).searchParams.get("q") ?? "").trim().slice(0, 60);
    let query = supabaseAdmin
      .from("kassa_clients")
      .select("ms_id, name, phone, demands_count, demands_sum, last_demand_at, bonus_balance, bonus_available, bonus_waiting", { count: "exact" })
      .order("last_demand_at", { ascending: false, nullsFirst: false })
      .limit(60);
    if (q) {
      const digits = q.replace(/\D/g, "");
      // в запросе в основном цифры — ищем по телефону (по последним 10 цифрам), иначе по имени
      if (digits.length >= 3 && digits.length >= q.replace(/\s/g, "").length - 1) {
        const tail = digits.length >= 10 ? digits.slice(-10) : digits;
        query = query.ilike("phone_digits", `%${tail}%`);
      } else {
        query = query.ilike("name", `%${q.replace(/[%_\\]/g, "\\$&")}%`);
      }
    }
    const { data, count, error } = await query;
    if (error) throw error;
    return NextResponse.json({ clients: data ?? [], total: count ?? 0 });
  } catch (e) {
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}
