"use client";

import { useSyncExternalStore } from "react";
import { Sun, Moon } from "lucide-react";

export interface ThemeToggleProps {
  className?: string;
  size?: "sm" | "md";
}

function subscribe(callback: () => void) {
  if (typeof window === "undefined") return () => {};

  window.addEventListener("storage", callback);
  window.addEventListener("themechange", callback);

  const observer = new MutationObserver(() => {
    callback();
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme"],
  });

  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener("themechange", callback);
    observer.disconnect();
  };
}

function getSnapshot(): "light" | "dark" {
  if (typeof document !== "undefined") {
    return document.documentElement.classList.contains("dark") ? "dark" : "light";
  }
  return "light";
}

function getServerSnapshot(): "light" | "dark" {
  return "light";
}

export function ThemeToggle({ className = "", size = "md" }: ThemeToggleProps) {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const toggle = () => {
    const isDark = document.documentElement.classList.contains("dark");
    const nextTheme = isDark ? "light" : "dark";

    if (nextTheme === "dark") {
      document.documentElement.classList.add("dark");
      document.documentElement.setAttribute("data-theme", "dark");
      try {
        localStorage.setItem("theme", "dark");
      } catch {}
    } else {
      document.documentElement.classList.remove("dark");
      document.documentElement.setAttribute("data-theme", "light");
      try {
        localStorage.setItem("theme", "light");
      } catch {}
    }

    window.dispatchEvent(new Event("themechange"));
  };

  const isSm = size === "sm";

  return (
    <button
      onClick={toggle}
      type="button"
      className={`inline-flex items-center justify-center rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white/80 dark:bg-slate-900/80 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 transition shadow-xs cursor-pointer ${
        isSm ? "p-1.5" : "p-2"
      } ${className}`}
      title={theme === "dark" ? "Basculer vers le thème clair (Papier)" : "Basculer vers le thème sombre (Nuit)"}
      aria-label="Basculer le thème clair / sombre"
      suppressHydrationWarning
    >
      {theme === "dark" ? (
        <Sun className={isSm ? "w-3.5 h-3.5 text-amber-400" : "w-4 h-4 text-amber-400"} />
      ) : (
        <Moon className={isSm ? "w-3.5 h-3.5 text-slate-700" : "w-4 h-4 text-slate-700"} />
      )}
    </button>
  );
}

export default ThemeToggle;
