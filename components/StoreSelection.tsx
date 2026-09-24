"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { useAuth } from "@/components/AuthGate";

const STORAGE_KEY = "overman.selectedStoreCodes";
// Snapshot of accessibleStoreCodes as of the last time we resolved a
// selection — lets us tell "the admin just widened this person's access"
// apart from "nothing changed, honour their saved filter". Without it, a
// stored selection from back when access was narrower (e.g. one city) stays
// forever once any of its stores are still valid, silently hiding newly
// granted ones — which looks exactly like "the new access isn't working".
const ACCESS_SNAPSHOT_KEY = "overman.accessibleStoreCodesSnapshot";

type StoreSelectionValue = {
  selected: string[];
  setSelected: (codes: string[]) => void;
  toggle: (code: string) => void;
  isAll: boolean;
  setAll: () => void;
};

const StoreSelectionContext = createContext<StoreSelectionValue>({
  selected: [],
  setSelected: () => {},
  toggle: () => {},
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

    let lastAccessible: string[] | null = null;
    try {
      const raw = window.localStorage.getItem(ACCESS_SNAPSHOT_KEY);
      if (raw) lastAccessible = JSON.parse(raw);
    } catch {
      lastAccessible = null;
    }
    const accessChanged =
      !lastAccessible ||
      lastAccessible.length !== accessibleStoreCodes.length ||
      !lastAccessible.every((c) => accessibleStoreCodes.includes(c));

    const valid = (stored ?? []).filter((c) => accessibleStoreCodes.includes(c));
    // A saved filter only survives if the accessible set hasn't changed since
    // it was made — the moment access is widened or narrowed, default back
    // to everything the person can now see, rather than quietly keeping a
    // stale subset.
    setSelectedState(accessChanged || valid.length === 0 ? accessibleStoreCodes : valid);

    try {
      window.localStorage.setItem(ACCESS_SNAPSHOT_KEY, JSON.stringify(accessibleStoreCodes));
    } catch {
      // ignore — per-viewer convenience only
    }
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

  const isAll = accessibleStoreCodes.length > 0 && selected.length === accessibleStoreCodes.length;

  return (
    <StoreSelectionContext.Provider
      value={{
        selected,
        setSelected: persist,
        toggle,
        isAll,
        setAll: () => persist(accessibleStoreCodes),
      }}
    >
      {children}
    </StoreSelectionContext.Provider>
  );
}
