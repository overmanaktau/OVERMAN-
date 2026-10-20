// Даты в названиях PDF-файлов: день.месяц.год («20.10.2026»), период — через дефис («14.10.2026-20.10.2026»).
export function ruDay(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}.${m}.${y}`;
}

export function ruPeriod(from: string, to: string): string {
  return from === to ? ruDay(from) : `${ruDay(from)}-${ruDay(to)}`;
}

export function todayRu(): string {
  const t = new Date();
  return `${String(t.getDate()).padStart(2, "0")}.${String(t.getMonth() + 1).padStart(2, "0")}.${t.getFullYear()}`;
}
