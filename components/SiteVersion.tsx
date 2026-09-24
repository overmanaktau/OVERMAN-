"use client";

import { createContext, useContext, useEffect, useState } from "react";

// "Для ПК" / "Мобильная" in the account menu is a manual override on top of
// the automatic (screen-width-based) layout — e.g. someone on a phone who
// wants the full desktop table view, or someone at a desktop testing the
// phone layout without resizing the window.
type Version = "desktop" | "mobile";
const STORAGE_KEY = "overman.siteVersion";

type SiteVersionValue = {
  mobileLayout: boolean; // effective, after resolving an unset override against real screen width
  version: Version | null; // explicit override, or null = follow screen width
  setVersion: (v: Version | null) => void;
};

const SiteVersionContext = createContext<SiteVersionValue>({
  mobileLayout: false,
  version: null,
  setVersion: () => {},
});

export function useSiteVersion() {
  return useContext(SiteVersionContext);
}

function matchesDesktop() {
  return typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches;
}

export function SiteVersionProvider({ children }: { children: React.ReactNode }) {
  const [version, setVersionState] = useState<Version | null>(null);
  const [isNarrow, setIsNarrow] = useState(() => !matchesDesktop());

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === "desktop" || stored === "mobile") setVersionState(stored);
    } catch {
      // ignore — per-viewer convenience only
    }
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const update = () => setIsNarrow(!mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  function setVersion(v: Version | null) {
    setVersionState(v);
    try {
      if (v) window.localStorage.setItem(STORAGE_KEY, v);
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore — per-viewer convenience only
    }
  }

  const mobileLayout = version === "mobile" ? true : version === "desktop" ? false : isNarrow;

  return (
    <SiteVersionContext.Provider value={{ mobileLayout, version, setVersion }}>
      {children}
    </SiteVersionContext.Provider>
  );
}
