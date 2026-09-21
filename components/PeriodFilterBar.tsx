"use client";

export type PeriodMode = "all" | "custom";

export default function PeriodFilterBar({
  mode,
  onModeChange,
  dateFrom,
  onDateFromChange,
  dateTo,
  onDateToChange,
}: {
  mode: PeriodMode;
  onModeChange: (mode: PeriodMode) => void;
  dateFrom: string;
  onDateFromChange: (value: string) => void;
  dateTo: string;
  onDateToChange: (value: string) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 bg-surface border border-border rounded-card p-1.5 w-fit flex-wrap">
      <button
        type="button"
        onClick={() => onModeChange("all")}
        className={`text-[13px] rounded-md px-3.5 py-2 ${
          mode === "all" ? "bg-accent text-paper font-bold" : "text-muted font-medium"
        }`}
      >
        Всё время
      </button>
      <button
        type="button"
        onClick={() => onModeChange("custom")}
        className={`text-[13px] rounded-md px-3.5 py-2 ${
          mode === "custom" ? "bg-accent text-paper font-bold" : "text-muted font-medium"
        }`}
      >
        Свой период
      </button>
      {mode === "custom" && (
        <div className="flex items-center gap-1.5 pl-2 ml-1 border-l border-border">
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => onDateFromChange(e.target.value)}
            className="text-[13px] bg-paper border border-border rounded-md px-2 py-1.5"
          />
          <span className="text-muted text-xs">—</span>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => onDateToChange(e.target.value)}
            className="text-[13px] bg-paper border border-border rounded-md px-2 py-1.5"
          />
        </div>
      )}
    </div>
  );
}
