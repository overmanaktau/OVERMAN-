type Tone = "positive" | "warning" | "negative" | "neutral";

type KpiCardProps = {
  label: string;
  value: string;
  valueSuffix?: string;
  valueTone?: Tone;
  note?: string;
  noteTone?: "positive" | "negative" | "neutral";
};

const toneClass: Record<Tone, string> = {
  positive: "text-accent",
  warning: "text-[#B8752E]",
  negative: "text-[#A34B36]",
  neutral: "text-ink",
};

const noteToneClass: Record<NonNullable<KpiCardProps["noteTone"]>, string> = {
  positive: "text-accent",
  negative: "text-[#A34B36]",
  neutral: "text-muted",
};

export default function KpiCard({ label, value, valueSuffix, valueTone = "neutral", note, noteTone = "neutral" }: KpiCardProps) {
  return (
    <div className="bg-surface border border-border rounded-card px-[18px] py-4 flex flex-col gap-2">
      <div className="text-xs text-muted">{label}</div>
      <div className="flex items-baseline gap-1.5">
        <div className={`font-serif text-[26px] font-semibold num ${toneClass[valueTone]}`}>{value}</div>
        {valueSuffix && <div className="text-xs text-muted num">{valueSuffix}</div>}
      </div>
      {note && <div className={`text-xs font-semibold num ${noteToneClass[noteTone]}`}>{note}</div>}
    </div>
  );
}
