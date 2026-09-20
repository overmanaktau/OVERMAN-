import type { Metadata } from "next";
import { Newsreader, Manrope } from "next/font/google";
import "./globals.css";
import ThemeProvider from "@/components/ThemeProvider";
import UnsavedChangesProvider from "@/components/UnsavedChangesContext";

// Runs before hydration so the page never flashes the wrong theme on load.
const NO_FLASH_SCRIPT = `
(function () {
  try {
    var stored = window.localStorage.getItem("overman.theme");
    var dark = stored === "dark" || (stored !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  } catch (e) {}
})();
`;

const newsreader = Newsreader({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-newsreader",
});

const manrope = Manrope({
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-manrope",
});

export const metadata: Metadata = {
  title: "Overman — портал бизнеса",
  description: "Внутренний портал сети магазинов Overman",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ru">
      <head>
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH_SCRIPT }} />
      </head>
      <body className={`${newsreader.variable} ${manrope.variable} font-sans text-ink bg-paper`}>
        <ThemeProvider>
          <UnsavedChangesProvider>{children}</UnsavedChangesProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
