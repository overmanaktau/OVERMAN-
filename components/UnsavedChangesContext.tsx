"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

type Guard = { onSave: () => Promise<void> | void; onDiscard: () => void };

type UnsavedChangesValue = {
  isDirty: boolean;
  saving: boolean;
  setGuard: (dirty: boolean, guard: Guard | null) => void;
  requestNavigation: (navigate: () => void) => void;
  saveNow: () => Promise<void>;
};

const UnsavedChangesContext = createContext<UnsavedChangesValue>({
  isDirty: false,
  saving: false,
  setGuard: () => {},
  requestNavigation: (navigate) => navigate(),
  saveNow: async () => {},
});

export function useUnsavedChanges() {
  return useContext(UnsavedChangesContext);
}

export default function UnsavedChangesProvider({ children }: { children: React.ReactNode }) {
  const [isDirty, setIsDirty] = useState(false);
  const guardRef = useRef<Guard | null>(null);
  const [pendingNav, setPendingNav] = useState<(() => void) | null>(null);
  const [saving, setSaving] = useState(false);

  const setGuard = useCallback((dirty: boolean, guard: Guard | null) => {
    setIsDirty(dirty);
    guardRef.current = dirty ? guard : null;
  }, []);

  const requestNavigation = useCallback((navigate: () => void) => {
    if (!guardRef.current) {
      navigate();
      return;
    }
    setPendingNav(() => navigate);
  }, []);

  useEffect(() => {
    function handler(e: BeforeUnloadEvent) {
      if (!isDirty) return;
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  async function handleSaveAndGo() {
    const guard = guardRef.current;
    const go = pendingNav;
    if (!guard || !go) return;
    setSaving(true);
    try {
      await guard.onSave();
      guardRef.current = null;
      setIsDirty(false);
      setPendingNav(null);
      go();
    } finally {
      setSaving(false);
    }
  }

  function handleDiscardAndGo() {
    const guard = guardRef.current;
    const go = pendingNav;
    if (!go) return;
    guard?.onDiscard();
    guardRef.current = null;
    setIsDirty(false);
    setPendingNav(null);
    go();
  }

  function handleCancel() {
    setPendingNav(null);
  }

  async function saveNow() {
    const guard = guardRef.current;
    if (!guard) return;
    setSaving(true);
    try {
      await guard.onSave();
      guardRef.current = null;
      setIsDirty(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <UnsavedChangesContext.Provider value={{ isDirty, saving, setGuard, requestNavigation, saveNow }}>
      {children}
      {pendingNav && (
        <div className="fixed inset-0 z-[200] bg-black/50 flex items-center justify-center p-6">
          <div className="bg-surface border border-border rounded-card p-6 max-w-sm w-full flex flex-col gap-4">
            <div className="text-[15px] font-bold text-ink">Сохранить изменения?</div>
            <p className="text-sm text-muted">
              У вас есть несохранённые изменения. Сохранить их перед переходом, или отменить переход?
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={handleCancel}
                className="text-[13px] font-semibold text-muted px-3.5 py-2 rounded-lg hover:bg-paper"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={handleDiscardAndGo}
                className="text-[13px] font-semibold text-[#A34B36] px-3.5 py-2 rounded-lg hover:bg-paper"
              >
                Не сохранять
              </button>
              <button
                type="button"
                onClick={handleSaveAndGo}
                disabled={saving}
                className="text-[13px] font-bold text-paper bg-accent rounded-lg px-4 py-2 disabled:opacity-50"
              >
                {saving ? "Сохраняем…" : "Сохранить"}
              </button>
            </div>
          </div>
        </div>
      )}
    </UnsavedChangesContext.Provider>
  );
}
