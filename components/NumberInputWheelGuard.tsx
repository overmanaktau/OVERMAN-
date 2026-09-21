"use client";

import { useEffect } from "react";

// Browsers change a focused number input's value on mouse-wheel scroll by
// default — easy to trigger by accident while scrolling past one. Blocked
// globally so no page has to remember to guard its own inputs, and only
// while the input is actually focused, so scrolling a table that happens
// to contain number inputs still works normally.
export default function NumberInputWheelGuard() {
  useEffect(() => {
    function handleWheel(e: WheelEvent) {
      const target = e.target;
      if (
        target instanceof HTMLInputElement &&
        target.type === "number" &&
        document.activeElement === target
      ) {
        e.preventDefault();
      }
    }
    document.addEventListener("wheel", handleWheel, { passive: false });
    return () => document.removeEventListener("wheel", handleWheel);
  }, []);

  return null;
}
