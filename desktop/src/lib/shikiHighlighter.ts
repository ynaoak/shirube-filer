// Shiki（TextMate 文法 / VS Code テーマ）によるテキストプレビューのシンタックスハイライト。
// highlight.js からの置き換え。WASM は使わず createJavaScriptRegexEngine（純 JS）を使うため
// CSP の変更は不要。言語・テーマは静的な明示 import のみを列挙し、Vite が 692 言語ぶんの
// チャンクを生成しないようにする（テンプレートリテラルの動的 import は禁止）。
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { HL_TOKEN_KEYS, type HlTokenKey } from "./highlightTheme";

type ShikiHighlighterCore = Awaited<ReturnType<typeof createHighlighterCore>>;

// ── 拡張子 → shiki 言語 id ───────────────────────────────────────────────
export const EXT_TO_SHIKI: Record<string, string> = {
  rs: "rust",
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  py: "python",
  go: "go",
  json: "json",
  toml: "toml",
  yaml: "yaml",
  yml: "yaml",
  css: "css",
  html: "html",
  xml: "xml",
  sh: "shellscript",
  bash: "bash",
  zsh: "zsh",
  c: "c",
  cpp: "cpp",
  h: "c",
  java: "java",
  rb: "ruby",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  kts: "kotlin",
  scss: "scss",
  less: "less",
  sql: "sql",
  lua: "lua",
  dart: "dart",
  r: "r",
  scala: "scala",
  graphql: "graphql",
  proto: "proto",
  pl: "perl",
  ps1: "powershell",
  jl: "julia",
  ex: "elixir",
  exs: "elixir",
  clj: "clojure",
  cljs: "clojure",
  fs: "fsharp",
  dockerfile: "dockerfile",
  ini: "ini",
  cs: "csharp",
  vue: "vue",
  svelte: "svelte",
  tf: "hcl",
  hcl: "hcl",
  zig: "zig",
  hs: "haskell",
  elm: "elm",
  nim: "nim",
  v: "v",
  cmake: "cmake",
  makefile: "makefile",
  make: "makefile",
  gradle: "groovy",
  groovy: "groovy",
  bat: "batch",
  cmd: "batch",
};

export function shikiLangForExt(ext: string): string | null {
  if (!ext) return null;
  return EXT_TO_SHIKI[ext.toLowerCase()] ?? null;
}

// ── 言語グラマーの明示ローダー（テンプレートリテラル動的 import は不可） ──────
// 各 shiki/dist/langs/*.mjs の default export は自己完結した配列（依存グラマーを
// 埋め込んでいるものもある。例: tsx は typescript を内包）。
const LANG_LOADERS: Record<string, () => Promise<any>> = {
  rust: () => import("shiki/dist/langs/rust.mjs"),
  typescript: () => import("shiki/dist/langs/typescript.mjs"),
  tsx: () => import("shiki/dist/langs/tsx.mjs"),
  javascript: () => import("shiki/dist/langs/javascript.mjs"),
  jsx: () => import("shiki/dist/langs/jsx.mjs"),
  python: () => import("shiki/dist/langs/python.mjs"),
  go: () => import("shiki/dist/langs/go.mjs"),
  json: () => import("shiki/dist/langs/json.mjs"),
  toml: () => import("shiki/dist/langs/toml.mjs"),
  yaml: () => import("shiki/dist/langs/yaml.mjs"),
  css: () => import("shiki/dist/langs/css.mjs"),
  html: () => import("shiki/dist/langs/html.mjs"),
  xml: () => import("shiki/dist/langs/xml.mjs"),
  shellscript: () => import("shiki/dist/langs/shellscript.mjs"),
  bash: () => import("shiki/dist/langs/bash.mjs"),
  zsh: () => import("shiki/dist/langs/zsh.mjs"),
  c: () => import("shiki/dist/langs/c.mjs"),
  cpp: () => import("shiki/dist/langs/cpp.mjs"),
  java: () => import("shiki/dist/langs/java.mjs"),
  ruby: () => import("shiki/dist/langs/ruby.mjs"),
  php: () => import("shiki/dist/langs/php.mjs"),
  swift: () => import("shiki/dist/langs/swift.mjs"),
  kotlin: () => import("shiki/dist/langs/kotlin.mjs"),
  scss: () => import("shiki/dist/langs/scss.mjs"),
  less: () => import("shiki/dist/langs/less.mjs"),
  sql: () => import("shiki/dist/langs/sql.mjs"),
  lua: () => import("shiki/dist/langs/lua.mjs"),
  dart: () => import("shiki/dist/langs/dart.mjs"),
  r: () => import("shiki/dist/langs/r.mjs"),
  scala: () => import("shiki/dist/langs/scala.mjs"),
  graphql: () => import("shiki/dist/langs/graphql.mjs"),
  proto: () => import("shiki/dist/langs/proto.mjs"),
  perl: () => import("shiki/dist/langs/perl.mjs"),
  powershell: () => import("shiki/dist/langs/powershell.mjs"),
  julia: () => import("shiki/dist/langs/julia.mjs"),
  elixir: () => import("shiki/dist/langs/elixir.mjs"),
  clojure: () => import("shiki/dist/langs/clojure.mjs"),
  fsharp: () => import("shiki/dist/langs/fsharp.mjs"),
  dockerfile: () => import("shiki/dist/langs/dockerfile.mjs"),
  ini: () => import("shiki/dist/langs/ini.mjs"),
  csharp: () => import("shiki/dist/langs/csharp.mjs"),
  vue: () => import("shiki/dist/langs/vue.mjs"),
  svelte: () => import("shiki/dist/langs/svelte.mjs"),
  hcl: () => import("shiki/dist/langs/hcl.mjs"),
  zig: () => import("shiki/dist/langs/zig.mjs"),
  haskell: () => import("shiki/dist/langs/haskell.mjs"),
  elm: () => import("shiki/dist/langs/elm.mjs"),
  nim: () => import("shiki/dist/langs/nim.mjs"),
  v: () => import("shiki/dist/langs/v.mjs"),
  cmake: () => import("shiki/dist/langs/cmake.mjs"),
  makefile: () => import("shiki/dist/langs/makefile.mjs"),
  groovy: () => import("shiki/dist/langs/groovy.mjs"),
  batch: () => import("shiki/dist/langs/batch.mjs"),
};

// ── 組み込みテーマの明示ローダー ─────────────────────────────────────────
const BUILTIN_THEME_LOADERS: Record<string, () => Promise<any>> = {
  "dark-plus": () => import("shiki/dist/themes/dark-plus.mjs"),
  "light-plus": () => import("shiki/dist/themes/light-plus.mjs"),
  "github-dark": () => import("shiki/dist/themes/github-dark.mjs"),
  "github-light": () => import("shiki/dist/themes/github-light.mjs"),
  "one-dark-pro": () => import("shiki/dist/themes/one-dark-pro.mjs"),
  monokai: () => import("shiki/dist/themes/monokai.mjs"),
  nord: () => import("shiki/dist/themes/nord.mjs"),
  dracula: () => import("shiki/dist/themes/dracula.mjs"),
};

export const BUILTIN_THEME_IDS = Object.keys(BUILTIN_THEME_LOADERS);

// ── VS Code テーマ JSON の最小型 ────────────────────────────────────────
type TokenColorRule = {
  name?: string;
  scope?: string | string[];
  settings: Record<string, unknown>;
};

export type ThemeJson = {
  name?: string;
  type?: string;
  colors?: Record<string, string>;
  tokenColors?: TokenColorRule[];
  semanticHighlighting?: boolean;
  semanticTokenColors?: Record<string, unknown>;
  [key: string]: unknown;
};

// ── トークン → スコープの対応表（split-and-recolor 用） ─────────────────
// 評価順（先勝ち）。number を keyword より先に評価することで、
// keyword.other.unit のような単位系スコープが誤って keyword に取られるのを防ぐ。
const CLAIM_ORDER: HlTokenKey[] = [
  "comment", "string", "number", "keyword", "function", "type", "attr", "meta",
];

const TOKEN_SCOPES: Partial<Record<HlTokenKey, { prefixes: string[]; excludes?: string[] }>> = {
  comment: { prefixes: ["comment", "punctuation.definition.comment"] },
  string: { prefixes: ["string", "punctuation.definition.string"] },
  number: {
    prefixes: [
      "constant.numeric", "constant.language.boolean", "constant.language.null",
      "constant.language.undefined", "keyword.other.unit",
    ],
  },
  keyword: {
    prefixes: ["keyword", "storage"],
    excludes: ["keyword.operator", "keyword.other.unit"],
  },
  function: { prefixes: ["entity.name.function", "support.function"] },
  type: { prefixes: ["entity.name.type", "support.type", "support.class", "entity.name.namespace"] },
  attr: { prefixes: ["entity.other.attribute-name", "variable.parameter"] },
  meta: { prefixes: ["meta.preprocessor", "meta.decorator", "punctuation.decorator", "entity.name.tag"] },
};

function matchesPrefix(scope: string, prefix: string): boolean {
  return scope === prefix || scope.startsWith(prefix + ".");
}

/**
 * ベーステーマの tokenColors に、トークン別オーバーライド色を「分割・再着色」方式で適用する。
 * 単純に一般規則を末尾追加するだけでは、ベーステーマ内のより深いスコープ（例: storage.type）
 * が優先されてしまい上書きできない。逆に既存規則をまるごと塗り替えると、混在スコープ配列
 * （例: constant.numeric と keyword.operator.plus.exponent が同一ルール）で無関係なスコープに
 * まで色が漏れる。そのため各ルールのスコープ配列を「クレームされた分」と「未クレーム分」に
 * 分割し、クレームされた分だけ新しい foreground を持つ別ルールとして分離する。
 */
export function buildOverrideTheme(base: ThemeJson, overrides: Partial<Record<HlTokenKey, string>>): ThemeJson {
  const activeTokens = CLAIM_ORDER.filter((k) => overrides[k] !== undefined && TOKEN_SCOPES[k]);
  const hasBg = !!overrides.bg;
  const hasFg = !!overrides.fg;

  if (activeTokens.length === 0 && !hasBg && !hasFg) return base;

  let newTokenColors: TokenColorRule[] = base.tokenColors ?? [];

  if (activeTokens.length > 0) {
    const rebuilt: TokenColorRule[] = [];
    for (const rule of base.tokenColors ?? []) {
      const scopes = Array.isArray(rule.scope) ? rule.scope : rule.scope ? [rule.scope] : [];
      if (scopes.length === 0) {
        rebuilt.push(rule);
        continue;
      }
      const unclaimed: string[] = [];
      const claimedMap = new Map<HlTokenKey, string[]>();
      for (const scope of scopes) {
        let claimedBy: HlTokenKey | null = null;
        for (const token of activeTokens) {
          const def = TOKEN_SCOPES[token]!;
          if (!def.prefixes.some((p) => matchesPrefix(scope, p))) continue;
          if ((def.excludes ?? []).some((ex) => matchesPrefix(scope, ex))) continue;
          claimedBy = token;
          break;
        }
        if (claimedBy) {
          const arr = claimedMap.get(claimedBy) ?? [];
          arr.push(scope);
          claimedMap.set(claimedBy, arr);
        } else {
          unclaimed.push(scope);
        }
      }
      if (unclaimed.length > 0) {
        rebuilt.push({ ...rule, scope: unclaimed.length === 1 ? unclaimed[0] : unclaimed });
      }
      for (const [token, tokenScopes] of claimedMap) {
        rebuilt.push({
          scope: tokenScopes.length === 1 ? tokenScopes[0] : tokenScopes,
          settings: { ...rule.settings, foreground: overrides[token] },
        });
      }
    }
    // 汎用の後付けルール（末尾）。深いスコープを持つ既存ルールは上で分離済みのため、
    // ここでの浅いスコープ指定が誤って他を上書きすることはない。
    for (const token of activeTokens) {
      rebuilt.push({
        scope: TOKEN_SCOPES[token]!.prefixes,
        settings: { foreground: overrides[token] },
      });
    }
    newTokenColors = rebuilt;
  }

  const newColors: Record<string, string> = { ...(base.colors ?? {}) };
  if (hasBg) newColors["editor.background"] = overrides.bg!;
  if (hasFg) newColors["editor.foreground"] = overrides.fg!;

  return {
    ...base,
    colors: newColors,
    tokenColors: newTokenColors,
  };
}

function pickValidOverrides(overrides: Record<string, string>): Partial<Record<HlTokenKey, string>> {
  const result: Partial<Record<HlTokenKey, string>> = {};
  for (const key of HL_TOKEN_KEYS) {
    const v = overrides[key];
    if (v && /^#[0-9a-fA-F]{6}$/.test(v)) result[key] = v;
  }
  return result;
}

/** VS Code テーマ JSON をシキ用に最小サニタイズ。tokenColors / colors のいずれも無ければ無効。 */
function sanitizeCustomTheme(raw: unknown): ThemeJson | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const tokenColors = Array.isArray(obj.tokenColors) ? (obj.tokenColors as TokenColorRule[]) : undefined;
  const colors = obj.colors && typeof obj.colors === "object" ? (obj.colors as Record<string, string>) : undefined;
  if (!tokenColors && !colors) return null;
  const sanitized: ThemeJson = {
    type: typeof obj.type === "string" ? obj.type : "dark",
    colors: colors ?? {},
    tokenColors: tokenColors ?? [],
  };
  if (typeof obj.semanticHighlighting === "boolean") sanitized.semanticHighlighting = obj.semanticHighlighting;
  if (obj.semanticTokenColors && typeof obj.semanticTokenColors === "object") {
    sanitized.semanticTokenColors = obj.semanticTokenColors as Record<string, unknown>;
  }
  // 内容のハッシュを名前に含めることで、インポートし直したテーマが取り違えられないようにする
  // （固定名だと、別内容のテーマを同名で再登録しても shiki 側は初回登録分を使い回してしまう）。
  const contentHash = hashString(JSON.stringify({ colors: sanitized.colors, tokenColors: sanitized.tokenColors }));
  sanitized.name = `kf-custom-${contentHash}`;
  return sanitized;
}

function hashString(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

// ── ハイライタのシングルトン ────────────────────────────────────────────
let highlighterPromise: Promise<ShikiHighlighterCore> | null = null;
function getHighlighter(): Promise<ShikiHighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [],
      langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  }
  return highlighterPromise;
}

const loadedLangs = new Set<string>();
const loadingLangs = new Map<string, Promise<void>>();

async function ensureLanguage(highlighter: ShikiHighlighterCore, id: string): Promise<boolean> {
  if (loadedLangs.has(id)) return true;
  const loader = LANG_LOADERS[id];
  if (!loader) return false;
  let p = loadingLangs.get(id);
  if (!p) {
    p = loader().then(async (mod) => {
      const grammars = Array.isArray(mod.default) ? mod.default : [mod.default];
      await highlighter.loadLanguage(...(grammars as Parameters<typeof highlighter.loadLanguage>));
      loadedLangs.add(id);
    });
    loadingLangs.set(id, p);
  }
  await p;
  return true;
}

const rawBuiltinThemePromises = new Map<string, Promise<ThemeJson>>();
function loadRawBuiltinTheme(id: string): Promise<ThemeJson> | null {
  const loader = BUILTIN_THEME_LOADERS[id];
  if (!loader) return null;
  let p = rawBuiltinThemePromises.get(id);
  if (!p) {
    p = loader().then((mod) => mod.default as ThemeJson);
    rawBuiltinThemePromises.set(id, p);
  }
  return p;
}

const registeredThemeNames = new Set<string>();
async function registerTheme(highlighter: ShikiHighlighterCore, theme: ThemeJson): Promise<string> {
  const name = theme.name ?? "theme";
  if (!registeredThemeNames.has(name)) {
    await highlighter.loadTheme(theme as Parameters<typeof highlighter.loadTheme>[0]);
    registeredThemeNames.add(name);
  }
  return name;
}

function resolveBuiltinThemeId(theme: string, appIsDark: boolean): string | null {
  if (theme === "dark") return "dark-plus"; // 後方互換
  if (theme === "light") return "light-plus";
  if (theme === "app") return appIsDark ? "dark-plus" : "light-plus";
  if (theme in BUILTIN_THEME_LOADERS) return theme;
  return null;
}

async function resolveThemeName(
  highlighter: ShikiHighlighterCore,
  opts: {
    theme: string;
    appIsDark: boolean;
    overrides: Record<string, string>;
    customTheme: object | null;
  },
): Promise<string | null> {
  let baseObj: ThemeJson;

  if (opts.theme === "custom") {
    if (!opts.customTheme) return null;
    const sanitized = sanitizeCustomTheme(opts.customTheme);
    if (!sanitized) return null;
    baseObj = sanitized;
  } else {
    const baseId = resolveBuiltinThemeId(opts.theme, opts.appIsDark);
    if (!baseId) return null;
    const raw = loadRawBuiltinTheme(baseId);
    if (!raw) return null;
    baseObj = { ...(await raw), name: baseId };
  }

  const baseName = await registerTheme(highlighter, baseObj);

  const validOverrides = pickValidOverrides(opts.overrides);
  if (Object.keys(validOverrides).length === 0) return baseName;

  const hash = hashString(JSON.stringify(validOverrides));
  const synthName = `${baseName}--${hash}`;
  if (!registeredThemeNames.has(synthName)) {
    const synthTheme = buildOverrideTheme(baseObj, validOverrides);
    synthTheme.name = synthName;
    await highlighter.loadTheme(synthTheme as Parameters<typeof highlighter.loadTheme>[0]);
    registeredThemeNames.add(synthName);
  }
  return synthName;
}

const MAX_CODE_LENGTH = 2_000_000;

export async function highlightWithShiki(
  code: string,
  ext: string,
  opts: {
    theme: string;
    appIsDark: boolean;
    overrides: Record<string, string>;
    customTheme: object | null;
  },
): Promise<string | null> {
  if (code.length > MAX_CODE_LENGTH) return null;
  const lang = shikiLangForExt(ext);
  if (!lang) return null;

  try {
    const highlighter = await getHighlighter();
    const langOk = await ensureLanguage(highlighter, lang);
    if (!langOk) return null;

    const themeName = await resolveThemeName(highlighter, opts);
    if (!themeName) return null;

    return highlighter.codeToHtml(code, { lang, theme: themeName });
  } catch {
    return null;
  }
}
