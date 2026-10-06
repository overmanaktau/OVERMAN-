"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

// Склады, на которых сейчас реально есть товар (по текущим остаткам из МойСклад).
// null — пока загружается или не удалось узнать: тогда фильтры показывают всё, что доступно.
export function useStockedWarehouses(): Set<string> | null {
  const [stocked, setStocked] = useState<Set<string> | null>(null);
  useEffect(() => {
    let cancelled = false;
    supabase.rpc("stock_warehouses").then(({ data }) => {
      if (!cancelled && data) setStocked(new Set((data as { store: string }[]).map((r) => r.store)));
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return stocked;
}
