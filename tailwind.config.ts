import type { Config } from "tailwindcss";

// Design tokens ported 1:1 from the Overman portal mockup.
// Keep this file as the single source of truth for the visual
// identity — every new screen should pull colors/fonts from here
// rather than hardcoding hex values again.
const config: Config = {
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // These resolve through CSS variables (see app/globals.css) so a
        // single `.dark` class on <html> re-themes every existing usage
        // without touching each component's classNames.
        paper: "var(--color-paper)",           // page background
        ink: "var(--color-ink)",               // primary text
        muted: "var(--color-muted)",           // secondary text
        mutedLight: "var(--color-muted-light)", // tertiary text / labels
        border: "var(--color-border)",         // card borders, dividers
        borderSoft: "var(--color-border-soft)", // row dividers inside cards
        surface: "var(--color-surface)",       // card background (was bg-white)
        sidebar: "#17140F",     // sidebar background — stays dark in both themes
        sidebarText: "#EDE8DF", // sidebar primary text
        sidebarMuted: "#8C8577",
        accent: "var(--color-accent)",         // deep green — primary action / active state
        weekendTint: "var(--color-weekend-tint)",
        cellBorder: "var(--color-cell-border)",
      },
      fontFamily: {
        serif: ["var(--font-newsreader)", "Georgia", "serif"],
        sans: ["var(--font-manrope)", "system-ui", "sans-serif"],
      },
      borderRadius: {
        card: "10px",
      },
    },
  },
  plugins: [],
};

export default config;
