// Сотрудники бота СММ: загрузка, рассылка по городам, журнал отправленного (чтобы не слать дважды).
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { citiesOf, type CityKey, type SmmRole } from "@/lib/smm/config";

export type SmmStatus = "pending" | "approved" | "rejected" | "disabled" | "left";
export type SmmUser = {
  id: number;
  telegram_user_id: number;
  telegram_chat_id: number;
  username: string | null;
  name: string;
  role: SmmRole;
  status: SmmStatus;
  awaiting: string | null;
  state: Record<string, unknown> | null;
};

export async function approvedUsers(): Promise<SmmUser[]> {
  const { data, error } = await supabaseAdmin.from("smm_users").select("*").eq("status", "approved");
  if (error) throw error;
  return (data ?? []) as SmmUser[];
}

export const usersForCity = (users: SmmUser[], city: CityKey) => users.filter((u) => citiesOf(u.role).includes(city));

export async function wasSent(userId: number, kind: string, date: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin.from("smm_messages_sent").select("user_id").eq("user_id", userId).eq("kind", kind).eq("ref_date", date).maybeSingle();
  if (error) throw error;
  return !!data;
}

export async function markSent(userId: number, kind: string, date: string): Promise<void> {
  const { error } = await supabaseAdmin.from("smm_messages_sent").upsert({ user_id: userId, kind, ref_date: date }, { onConflict: "user_id,kind,ref_date" });
  if (error) throw error;
}
