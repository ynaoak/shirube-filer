import { useEffect, useState } from "react";

/**
 * アプリの現在のテーマがダークかどうかを追跡する。
 * ThemeProvider は `document.documentElement` に "dark" クラスを付け外しするだけなので、
 * MutationObserver でそれを監視する（テーマストアへの直接依存を避けるため）。
 */
export function useAppIsDark(): boolean {
  const [isDark, setIsDark] = useState(
    () => document.documentElement.classList.contains("dark"),
  );

  useEffect(() => {
    const el = document.documentElement;
    const observer = new MutationObserver(() => {
      setIsDark(el.classList.contains("dark"));
    });
    observer.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return isDark;
}
