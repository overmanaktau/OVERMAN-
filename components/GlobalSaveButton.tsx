"use client";

import { useUnsavedChanges } from "@/components/UnsavedChangesContext";

export default function GlobalSaveButton() {
  const { isDirty, saving, justSaved, saveNow } = useUnsavedChanges();

  const label = saving ? "Сохраняем…" : justSaved ? "Сохранено" : "Сохранить";
  const title = isDirty ? "Сохранить изменения" : justSaved ? "Изменения сохранены" : "Нет несохранённых изменений";

  return (
    <button
      type="button"
      disabled={!isDirty || saving}
      onClick={saveNow}
      title={title}
      className={`text-[13px] font-bold rounded-full px-4 py-2 shadow-md transition-colors ${
        isDirty ? "bg-accent text-paper" : "bg-[#C9C9C9] text-[#8A8A8A] cursor-not-allowed"
      }`}
    >
      {label}
    </button>
  );
}
