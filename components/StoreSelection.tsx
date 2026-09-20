"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { useAuth } from "@/components/AuthGate";

const STORAGE_KEY = "overman.selectedStoreCodes";

type StoreSelectionValue = {
  selected: string[];
  setSelected: (codes: string[]) => void;
  toggle: (code: string) => void;
  toggleMany: (codes: string[], select: boolean) => void;
  isAll: boolean;
  setAll: () => void;
};

const StoreSelectionContext = createContext<StoreSelectionValue>({
  selected: [],
  setSelected: () => {},
  toggle: () => {},
  toggleMany: () => {},
  isAll: true,
  setAll: () => {},
});

export function useStoreSelection() {
  return useContext(StoreSelectionContext);
}

export function StoreSelectionProvider({ children }: { children: React.ReactNode }) {
  const { accessibleStoreCodes } = useAuth();
  const [selected, setSelectedState] = useState<string[]>([]);

  useEffect(() => {
    let stored: string[] | null = null;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) stored = JSON.parse(raw);
    } catch {
      stored = null;
    }
    const valid = (stored ?? []).filter((c) => accessibleStoreCodes.includes(c));
    setSelectedState(valid.length > 0 ? valid : accessibleStoreCodes);
    // Re-run whenever the accessible set changes (e.g. after login finishes loading).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessibleStoreCodes.join(",")]);

  function persist(codes: string[]) {
    setSelectedState(codes);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(codes));
    } catch {
      // ignore — per-viewer convenience only
    }
  }

  function toggle(code: string) {
    persist(selected.includes(code) ? selected.filter((c) => c !== code) : [...selected, code]);
  }

  function toggleMany(codes: string[], select: boolean) {
    const codeSet = new Set(codes);
    persist(
      select
        ? [...selected.filter((c) => !codeSet.has(c)), ...codes]
        : selected.filter((c) => !codeSet.has(c))
    );
  }

  const isAll = accessibleStoreCodes.length > 0 && selected.length === accessibleStoreCodes.length;

  return (
    <StoreSelectionContext.Provider
      value={{
        selected,
        setSelected: persist,
        toggle,
        toggleMany,
        isAll,
        setAll: () => persist(accessibleStoreCodes),
      }}
    >
      {children}
    </StoreSelectionContext.Provider>
  );
}
