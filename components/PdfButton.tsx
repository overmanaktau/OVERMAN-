"use client";

import { useMemo, useState } from "react";
import { useAuth } from "@/components/AuthGate";
import { downloadPdf, type PdfDoc, type PdfSection } from "@/lib/downloadPdf";

// Кнопка «Скачать PDF»: страница отдаёт описание документа (заголовок, показатели,
// таблицы), оформление и сам файл делает lib/exportPdf. По нажатию открывается окно
// «Что скачать»: можно выбрать блоки, колонки, глубину детализации и конкретные строки.
export default function PdfButton({
  build,
  className,
  label = "Скачать PDF",
  disabled,
}: {
  build: () => PdfDoc | Promise<PdfDoc>;
  className?: string;
  label?: string;
  disabled?: boolean;
}) {
  const { fullName, email } = useAuth();
  const [busy, setBusy] = useState(false);
  const [doc, setDoc] = useState<PdfDoc | null>(null);

  async function onClick() {
    setBusy(true);
    try {
      setDoc(await build());
    } catch (e) {
      window.alert(`Не удалось подготовить PDF: ${e instanceof Error ? e.message : "ошибка"}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        disabled={busy || disabled}
        className={className ?? "text-[13px] font-semibold text-accent bg-surface border border-border rounded-md px-3.5 py-2 hover:bg-paper disabled:opacity-50"}
      >
        {busy ? "Готовим…" : label}
      </button>
      {doc && <Chooser doc={doc} author={fullName ?? email} onClose={() => setDoc(null)} />}
    </>
  );
}

// ───────── структура таблицы: уровни вложенности и «единицы» строк

type Shape = {
  levels: number[]; // уровень каждой строки: 0 — основная, 1+ — вложенные
  unitOf: number[]; // номер единицы (основная строка + её вложенные); -1 для итоговой строки
  unitLabels: string[];
  maxLevel: number;
};

function shapeOf(sec: PdfSection): Shape {
  const levels: number[] = [];
  const unitOf: number[] = [];
  const unitLabels: string[] = [];
  let current = -1;
  sec.rows.forEach((row, i) => {
    const kind = sec.rowKinds?.[i] ?? "normal";
    const level = sec.indent?.[i] ?? (kind === "sub" ? 1 : 0);
    levels.push(level);
    if (kind === "total") {
      unitOf.push(-1);
      current = -1;
      return;
    }
    if (level === 0 || current < 0) {
      current = unitLabels.length;
      unitLabels.push(String(row[0] ?? "").trim() || "—");
    }
    unitOf.push(current);
  });
  // у подгружаемого блока строк ещё нет — уровни берём из названий уровней
  const maxLevel = sec.load ? Math.max(0, (sec.levelLabels?.length ?? 1) - 1) : levels.reduce((a, b) => Math.max(a, b), 0);
  return { levels, unitOf, unitLabels: sec.load ? sec.units ?? [] : unitLabels, maxLevel };
}

type SecCfg = {
  on: boolean;
  cols: boolean[];
  level: number;
  excluded: Set<number>;
  manual: boolean;
  search: string;
  from: string;
  to: string;
  query: string;
};

function initialCfg(sec: PdfSection): SecCfg {
  return { on: !sec.optional, cols: sec.headers.map(() => true), level: shapeOf(sec).maxLevel, excluded: new Set(), manual: false, search: "", from: "", to: "", query: "" };
}

function applyCfg(sec: PdfSection, cfg: SecCfg, withNotes: boolean): PdfSection {
  const shape = shapeOf(sec);
  const keepCols = cfg.cols.map((v, i) => v || i === 0);
  const rowsIdx: number[] = [];
  const partial = cfg.excluded.size > 0;
  sec.rows.forEach((_, i) => {
    const u = shape.unitOf[i];
    if (u === -1) {
      if (!partial) rowsIdx.push(i); // итоги не показываем, если выбраны не все строки — они бы не сходились
      return;
    }
    if (cfg.excluded.has(u)) return;
    if (shape.levels[i] > cfg.level) return;
    rowsIdx.push(i);
  });
  const pickCols = <T,>(arr: T[] | undefined) => (arr ? arr.filter((_, i) => keepCols[i]) : undefined);
  return {
    ...sec,
    note: withNotes ? sec.note : undefined,
    headers: sec.headers.filter((_, i) => keepCols[i]),
    rows: rowsIdx.map((i) => sec.rows[i].filter((_, c) => keepCols[c])),
    align: pickCols(sec.align),
    widths: pickCols(sec.widths),
    rowKinds: sec.rowKinds ? rowsIdx.map((i) => sec.rowKinds![i]) : undefined,
    indent: sec.indent ? rowsIdx.map((i) => sec.indent![i]) : undefined,
    optional: undefined,
    load: undefined,
  };
}

// ───────── окно выбора

const ROW_LIST_LIMIT = 300;

function Chooser({ doc, author, onClose }: { doc: PdfDoc; author: string | null | undefined; onClose: () => void }) {
  const [kpiOn, setKpiOn] = useState<boolean[]>(() => (doc.kpis ?? []).map(() => true));
  const [cfgs, setCfgs] = useState<SecCfg[]>(() => doc.sections.map(initialCfg));
  const [notes, setNotes] = useState(true);
  const [orientation, setOrientation] = useState<"portrait" | "landscape">(doc.orientation ?? "landscape");
  const [fileName, setFileName] = useState(doc.fileName);
  const [open, setOpen] = useState<Set<string>>(new Set()); // раскрытые «Колонки» / «Строки»
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const shapes = useMemo(() => doc.sections.map(shapeOf), [doc]);

  const setCfg = (i: number, patch: Partial<SecCfg>) => setCfgs((prev) => prev.map((c, k) => (k === i ? { ...c, ...patch } : c)));
  const toggleOpen = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const anything = kpiOn.some(Boolean) || cfgs.some((c) => c.on);

  async function download() {
    setBusy(true);
    try {
      const sections: PdfSection[] = [];
      for (let i = 0; i < doc.sections.length; i++) {
        const cfg = cfgs[i];
        if (!cfg.on) continue;
        let sec = doc.sections[i];
        if (sec.load) {
          setProgress(`Подгружаем: ${sec.title ?? "таблица"}…`);
          const loaded = await sec.load({ skip: cfg.excluded, from: cfg.from || undefined, to: cfg.to || undefined, query: cfg.query.trim() || undefined });
          sec = {
            ...sec,
            ...loaded,
            headers: loaded.headers.length > 0 ? loaded.headers : sec.headers,
            widths: loaded.widths ?? sec.widths,
            align: loaded.align ?? sec.align,
            title: loaded.title ?? sec.title,
            note: [
              loaded.note ?? sec.note,
              cfg.from || cfg.to ? `Дата прихода: ${cfg.from ? `с ${cfg.from.split("-").reverse().join(".")}` : ""}${cfg.from && cfg.to ? " " : ""}${cfg.to ? `по ${cfg.to.split("-").reverse().join(".")}` : ""}` : "",
              cfg.query.trim() ? `Поиск: «${cfg.query.trim()}»` : "",
            ]
              .filter(Boolean)
              .join(" · ") || undefined,
          };
        }
        // колонки/уровень настроены по заготовке, у подгруженного блока колонок столько же
        // у подгруженного блока снятые строки уже не загружались — повторно не вычитаем
        sections.push(applyCfg(sec, { ...cfg, excluded: sec.rows === doc.sections[i].rows ? cfg.excluded : new Set() }, notes));
      }
      setProgress("Собираем PDF…");
      await downloadPdf({
        ...doc,
        fileName: fileName.trim() || doc.fileName,
        orientation,
        author: doc.author ?? author,
        meta: notes ? doc.meta : undefined,
        kpis: doc.kpis?.filter((_, i) => kpiOn[i]),
        sections,
      });
      onClose();
    } catch (e) {
      window.alert(`Не удалось сформировать PDF: ${e instanceof Error ? e.message : "ошибка"}`);
    } finally {
      setBusy(false);
      setProgress("");
    }
  }

  const box = "w-4 h-4 accent-[#2F4A3C] flex-none";
  const linkBtn = "text-[12px] font-semibold text-accent hover:underline";

  return (
    <div className="fixed inset-0 z-[100] bg-black/40 flex items-center justify-center p-3" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="bg-surface border border-border rounded-card shadow-xl w-full max-w-[560px] max-h-[92vh] flex flex-col">
        <div className="px-5 pt-4 pb-3 border-b border-border">
          <div className="font-serif text-[20px] font-semibold">Что скачать в PDF</div>
          <div className="text-[12.5px] text-muted mt-0.5">{doc.title}. Отметьте нужное — в файл попадёт только оно.</div>
        </div>

        <div className="overflow-y-auto px-5 py-3 flex flex-col gap-4 text-[13px]">
          {doc.kpis && doc.kpis.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-3">
                <div className="font-bold">Показатели (карточки сверху)</div>
                <button type="button" className={linkBtn} onClick={() => setKpiOn(kpiOn.map(() => true))}>все</button>
                <button type="button" className={linkBtn} onClick={() => setKpiOn(kpiOn.map(() => false))}>никакие</button>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {doc.kpis.map((k, i) => (
                  <label key={i} className="flex items-center gap-1.5 cursor-pointer">
                    <input type="checkbox" className={box} checked={kpiOn[i]} onChange={(e) => setKpiOn((p) => p.map((v, j) => (j === i ? e.target.checked : v)))} />
                    {k.label}
                  </label>
                ))}
              </div>
            </div>
          )}

          {doc.sections.map((sec, i) => {
            const cfg = cfgs[i];
            const shape = shapes[i];
            const lazy = !!sec.load;
            const colsOpen = open.has(`c${i}`);
            const rowsOpen = open.has(`r${i}`);
            const q = cfg.search.trim().toLowerCase();
            const listed = shape.unitLabels.map((label, u) => ({ label, u })).filter((x) => !q || x.label.toLowerCase().includes(q));
            const levelNames = sec.levelLabels ?? ["Только основные строки", "+ вложенные строки", "+ ещё глубже (всё)"];
            return (
              <div key={i} className="rounded-lg border border-borderSoft p-3 flex flex-col gap-2">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input type="checkbox" className={`${box} mt-0.5`} checked={cfg.on} onChange={(e) => setCfg(i, { on: e.target.checked })} />
                  <span className="min-w-0">
                    <span className="font-bold">{sec.title ?? `Таблица ${i + 1}`}</span>
                    <span className="text-mutedLight"> {lazy ? `· ${shape.unitLabels.length > 0 ? `${shape.unitLabels.length} строк, ` : ""}подгрузится при скачивании` : `· ${shape.unitLabels.length || sec.rows.length} строк`}</span>
                    {sec.hint && <span className="block text-[12px] text-muted font-normal">{sec.hint}</span>}
                  </span>
                </label>

                {cfg.on && (
                  <div className="pl-6 flex flex-col gap-2">
                    {sec.filters && (
                      <div className="flex items-center gap-x-3 gap-y-2 flex-wrap">
                        {sec.filters.dates && (
                          <>
                            <span className="text-muted text-[12.5px]">Дата прихода:</span>
                            <input type="date" value={cfg.from} max={cfg.to || undefined} onChange={(e) => setCfg(i, { from: e.target.value })} className="bg-paper border border-border rounded-md px-2 py-1 text-[12.5px]" />
                            <span className="text-muted">—</span>
                            <input type="date" value={cfg.to} min={cfg.from || undefined} onChange={(e) => setCfg(i, { to: e.target.value })} className="bg-paper border border-border rounded-md px-2 py-1 text-[12.5px]" />
                            {(cfg.from || cfg.to) && (
                              <button type="button" className={linkBtn} onClick={() => setCfg(i, { from: "", to: "" })}>
                                сбросить
                              </button>
                            )}
                          </>
                        )}
                        {sec.filters.query && (
                          <input
                            type="text"
                            value={cfg.query}
                            onChange={(e) => setCfg(i, { query: e.target.value })}
                            placeholder={sec.filters.query}
                            className="bg-paper border border-border rounded-md px-2 py-1 text-[12.5px] w-[220px]"
                          />
                        )}
                      </div>
                    )}
                    {shape.maxLevel > 0 && (
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-muted text-[12.5px]">Детализация:</span>
                        <select
                          value={cfg.level}
                          onChange={(e) => setCfg(i, { level: Number(e.target.value) })}
                          className="bg-paper border border-border rounded-md px-2 py-1 text-[12.5px]"
                        >
                          {Array.from({ length: shape.maxLevel + 1 }, (_, l) => (
                            <option key={l} value={l}>
                              {levelNames[l] ?? `Уровень ${l + 1}`}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

                    <div className="flex flex-col gap-1.5">
                      <button type="button" className={`${linkBtn} text-left w-fit`} onClick={() => toggleOpen(`c${i}`)}>
                        {colsOpen ? "▾" : "▸"} Колонки: {cfg.cols.filter(Boolean).length} из {cfg.cols.length}
                      </button>
                      {colsOpen && (
                        <div className="flex flex-wrap gap-x-4 gap-y-1.5 pl-3">
                          {sec.headers.map((h, c) => (
                            <label key={c} className={`flex items-center gap-1.5 ${c === 0 ? "opacity-60" : "cursor-pointer"}`}>
                              <input
                                type="checkbox"
                                className={box}
                                disabled={c === 0}
                                checked={cfg.cols[c] || c === 0}
                                onChange={(e) => setCfg(i, { cols: cfg.cols.map((v, k) => (k === c ? e.target.checked : v)) })}
                              />
                              {h || "—"}
                            </label>
                          ))}
                        </div>
                      )}
                    </div>

                    {shape.unitLabels.length > 1 && (
                      <div className="flex flex-col gap-1.5">
                        <button type="button" className={`${linkBtn} text-left w-fit`} onClick={() => toggleOpen(`r${i}`)}>
                          {rowsOpen ? "▾" : "▸"} Строки: {shape.unitLabels.length - cfg.excluded.size} из {shape.unitLabels.length}
                        </button>
                        {rowsOpen && (
                          <div className="pl-3 flex flex-col gap-1.5">
                            <div className="flex items-center gap-3 flex-wrap">
                              <input
                                type="text"
                                value={cfg.search}
                                onChange={(e) => setCfg(i, { search: e.target.value })}
                                placeholder="Найти строку…"
                                className="bg-paper border border-border rounded-md px-2 py-1 text-[12.5px] w-[170px]"
                              />
                              <button
                                type="button"
                                className={linkBtn}
                                onClick={() => {
                                  const next = new Set(cfg.excluded);
                                  listed.forEach((x) => next.delete(x.u));
                                  setCfg(i, { excluded: next });
                                }}
                              >
                                {q ? "отметить найденные" : "отметить все"}
                              </button>
                              <button
                                type="button"
                                className={linkBtn}
                                onClick={() => {
                                  const next = new Set(cfg.excluded);
                                  listed.forEach((x) => next.add(x.u));
                                  setCfg(i, { excluded: next });
                                }}
                              >
                                {q ? "снять найденные" : "снять все"}
                              </button>
                            </div>
                            <div className="max-h-[200px] overflow-y-auto border border-borderSoft rounded-md bg-paper/50 px-2 py-1.5 flex flex-col gap-1">
                              {listed.slice(0, ROW_LIST_LIMIT).map((x) => (
                                <label key={x.u} className="flex items-start gap-1.5 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    className={`${box} mt-0.5`}
                                    checked={!cfg.excluded.has(x.u)}
                                    onChange={(e) => {
                                      const next = new Set(cfg.excluded);
                                      if (e.target.checked) next.delete(x.u);
                                      else next.add(x.u);
                                      setCfg(i, { excluded: next });
                                    }}
                                  />
                                  <span className="break-words min-w-0">{x.label}</span>
                                </label>
                              ))}
                              {listed.length === 0 && <span className="text-mutedLight">Ничего не найдено.</span>}
                              {listed.length > ROW_LIST_LIMIT && (
                                <span className="text-mutedLight text-[12px]">Показаны первые {ROW_LIST_LIMIT} — уточните поиск.</span>
                              )}
                            </div>
                            {cfg.excluded.size > 0 && (
                              <div className="text-[12px] text-mutedLight">Итоговые строки не печатаются, когда выбраны не все строки.</div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          <div className="flex flex-col gap-2.5 pt-1">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" className={box} checked={notes} onChange={(e) => setNotes(e.target.checked)} />
              Пояснения под заголовками и таблицами
            </label>
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-muted">Страница:</span>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="radio" className={box} checked={orientation === "landscape"} onChange={() => setOrientation("landscape")} />
                альбомная
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="radio" className={box} checked={orientation === "portrait"} onChange={() => setOrientation("portrait")} />
                книжная
              </label>
            </div>
            <label className="flex items-center gap-2 flex-wrap">
              <span className="text-muted">Название файла:</span>
              <input
                type="text"
                value={fileName}
                onChange={(e) => setFileName(e.target.value)}
                className="bg-paper border border-border rounded-md px-2 py-1 text-[12.5px] flex-1 min-w-[160px]"
              />
              <span className="text-mutedLight">.pdf</span>
            </label>
          </div>
        </div>

        <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-2 flex-wrap">
          {progress && <span className="text-[12px] text-muted mr-auto">{progress}</span>}
          <button type="button" onClick={onClose} disabled={busy} className="text-[13px] font-semibold text-muted px-3 py-2 rounded-md hover:bg-paper disabled:opacity-50">
            Отмена
          </button>
          <button
            type="button"
            onClick={download}
            disabled={busy || !anything}
            className="text-[13px] font-bold text-paper bg-accent rounded-md px-4 py-2 disabled:opacity-50"
          >
            {busy ? "Готовим…" : "Скачать PDF"}
          </button>
        </div>
      </div>
    </div>
  );
}
