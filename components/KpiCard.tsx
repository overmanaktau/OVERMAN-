type KpiCardProps = {
  label: string;
  value: string;
  note?: string;
  noteTone?: "positive" | "negative" | "neutral";
};

const toneClass: Record<NonNullable<KpiCardProps["noteTone"]>, string> = {
  positive: "text-accent",
  negative: "text-[#A34B36]",
  neutral: "text-muted",
};

export default function KpiCard({ label, value, note, noteTone = "neutral" }: KpiCardProps) {
  return (
    <div className="bg-surface border border-border rounded-card px-[18px] py-4 flex flex-col gap-2">
      <div className="text-xs text-muted">{label}</div>
      <div className="font-serif text-[26px] font-semibold num">{value}</div>
      {note && <div className={`text-xs font-semibold num ${toneClass[noteTone]}`}>{note}</div>}
    </div>
  );
}
