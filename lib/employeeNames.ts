// В таблицах продаж и планов имя сотрудника записывается в момент продажи/плана. Если человека потом
// переименовали в МойСклад, на страницах портала («Продажа», план продаж) он остаётся под старым именем.
// Эта функция приводит имена во всех таблицах к актуальным из МойСклад (по employee_ms_id).
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchEmployeeNames } from "@/lib/moysklad";

const TABLES = ["moysklad_employee_sales_daily", "sales_plan_monthly"] as const;

export async function syncEmployeeNamesEverywhere(): Promise<{ renamed: number }> {
  const names = [...(await fetchEmployeeNames()).entries()];
  let renamed = 0;
  for (let i = 0; i < names.length; i += 6) {
    await Promise.all(
      names.slice(i, i + 6).flatMap(([id, name]) =>
        TABLES.map(async (table) => {
          const { data, error } = await supabaseAdmin.from(table).update({ employee_name: name }).eq("employee_ms_id", id).neq("employee_name", name).select("employee_ms_id");
          if (error) throw error;
          renamed += data?.length ?? 0;
        })
      )
    );
  }
  return { renamed };
}
