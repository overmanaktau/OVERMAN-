"use client";

// Заголовок колонки с двумя стрелками: ▼ — от большего к меньшему, ▲ — от меньшего к большему.
// Повторное нажатие на выбранную стрелку снимает сортировку (таблица возвращается к порядку по умолчанию).
export type SortDir = "asc" | "desc";
export type SortState<K extends string> = { key: K; dir: SortDir } | null;

export default function SortHead<K extends string>({
  label,
  k,
  sort,
  onSort,
  left,
}: {
  label: string;
  k: K;
  sort: SortState<K>;
  onSort: (s: SortState<K>) => void;
  left?: boolean;
}) {
  const btn = (dir: SortDir) => {
    const active = sort?.key === k && sort.dir === dir;
    return (
      <button
        type="button"
        title={dir === "desc" ? "От большего к меньшему" : "От меньшего к большему"}
        aria-label={dir === "desc" ? "Сортировать от большего к меньшему" : "Сортировать от меньшего к большему"}
        onClick={(e) => {
          e.stopPropagation();
          onSort(active ? null : { key: k, dir });
        }}
        className={`text-[10px] leading-none px-0.5 ${active ? "text-accent font-bold" : "text-mutedLight hover:text-ink"}`}
      >
        {dir === "desc" ? "▼" : "▲"}
      </button>
    );
  };
  return (
    <div className={`flex items-center gap-1 ${left ? "" : "justify-end"}`}>
      <span>{label}</span>
      <span className="flex items-center flex-none">
        {btn("desc")}
        {btn("asc")}
      </span>
    </div>
  );
}
