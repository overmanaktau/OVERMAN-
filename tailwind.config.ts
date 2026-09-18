import type { Config } from "tailwindcss";

// Design tokens ported 1:1 from the Overman portal mockup.
// Keep this file as the single source of truth for the visual
// identity — every new screen should pull colors/fonts from here
// rather than hardcoding hex values again.
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: "#F6F3EE",       // page background
        ink: "#1C1A17",         // primary text
        muted: "#5B5548",       // secondary text
        mutedLight: "#8C8577",  // tertiary text / labels
        border: "#E4DFD6",      // card borders, dividers
        borderSoft: "#EFEBE2",  // row dividers inside cards
        sidebar: "#17140F",     // sidebar background
        sidebarText: "#EDE8DF", // sidebar primary text
        sidebarMuted: "#8C8577",
        accent: "#2F4A3C",      // deep green — primary action / active state
        weekendTint: "#FBF8F1",
        cellBorder: "#ECE7DA",
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
