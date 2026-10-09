export const themeOptions = [
  { id: "dark-blue", label: "Dark Blue" },
  { id: "solarized-white", label: "Solarized White" },
  { id: "solarized-dark", label: "Solarized Dark" },
  { id: "retro-future", label: "Retro Future" }
] as const;

export type ThemeId = typeof themeOptions[number]["id"];
export const themeStorageKey = "infraops-theme";

export function isThemeId(value: unknown): value is ThemeId {
  return themeOptions.some((theme) => theme.id === value);
}

export function readThemePreference(): ThemeId {
  try {
    const saved = window.localStorage.getItem(themeStorageKey);
    return isThemeId(saved) ? saved : "dark-blue";
  } catch {
    return "dark-blue";
  }
}
