import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import ja from "./locales/ja.json";
import en from "./locales/en.json";

export type Language = "ja" | "en";

const savedLang = (localStorage.getItem("shirube-language") as Language) ?? "ja";

i18n
  .use(initReactI18next)
  .init({
    resources: {
      ja: { translation: ja },
      en: { translation: en },
    },
    lng: savedLang,
    fallbackLng: "ja",
    interpolation: {
      escapeValue: false,
    },
  });

export function setLanguage(lang: Language) {
  i18n.changeLanguage(lang);
  localStorage.setItem("shirube-language", lang);
}

export function getLanguage(): Language {
  return (i18n.language as Language) ?? "ja";
}

export default i18n;
