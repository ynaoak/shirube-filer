// 重い monaco-editor 本体・React ラッパーをまとめた「遅延ロード専用」モジュール。
// このファイルは PreviewPanel から React.lazy(() => import("./CodeEditor")) で読み込まれ、
// 編集モードに入った瞬間に初めて monaco-vendor チャンクを取得する。
// → アプリ起動時には monaco を読み込まないので初回表示が軽くなる。
//
// monaco は editor.main（全部入り）ではなく editor.api + editor.all + monarch 言語のみを
// 読み込む。typescript/css/html の言語サービス（合計 ~8.4MB のワーカー）はファイラーの
// 組み込みエディタには過剰（必要なのはシンタックスハイライト）で、ビルド時間と
// アプリサイズを大きく増やすため同梱しない。JSON のみハイライトが language service 側に
// しかないため contribution ごと読み込む（json.worker は小さい）。
import "../../monacoSetup"; // monaco 本体より前に Worker 環境を設定する必要がある
import * as monacoEditor from "monaco-editor/esm/vs/editor/editor.api.js";
import "monaco-editor/esm/vs/editor/editor.all";
// ── monarch ハイライト（言語サービスなし）: プレビュー対象の主要言語 ──
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution";
import "monaco-editor/esm/vs/basic-languages/go/go.contribution";
import "monaco-editor/esm/vs/basic-languages/rust/rust.contribution";
import "monaco-editor/esm/vs/basic-languages/css/css.contribution";
import "monaco-editor/esm/vs/basic-languages/scss/scss.contribution";
import "monaco-editor/esm/vs/basic-languages/less/less.contribution";
import "monaco-editor/esm/vs/basic-languages/html/html.contribution";
import "monaco-editor/esm/vs/basic-languages/xml/xml.contribution";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution";
import "monaco-editor/esm/vs/basic-languages/shell/shell.contribution";
import "monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution";
import "monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution";
import "monaco-editor/esm/vs/basic-languages/java/java.contribution";
import "monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution";
import "monaco-editor/esm/vs/basic-languages/php/php.contribution";
import "monaco-editor/esm/vs/basic-languages/swift/swift.contribution";
import "monaco-editor/esm/vs/basic-languages/kotlin/kotlin.contribution";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution";
import "monaco-editor/esm/vs/basic-languages/ini/ini.contribution";
import "monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution";
import "monaco-editor/esm/vs/basic-languages/lua/lua.contribution";
import "monaco-editor/esm/vs/basic-languages/dart/dart.contribution";
import "monaco-editor/esm/vs/basic-languages/r/r.contribution";
import "monaco-editor/esm/vs/basic-languages/scala/scala.contribution";
import "monaco-editor/esm/vs/basic-languages/graphql/graphql.contribution";
import "monaco-editor/esm/vs/basic-languages/protobuf/protobuf.contribution";
import "monaco-editor/esm/vs/basic-languages/perl/perl.contribution";
import "monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution";
import "monaco-editor/esm/vs/basic-languages/julia/julia.contribution";
import "monaco-editor/esm/vs/basic-languages/elixir/elixir.contribution";
import "monaco-editor/esm/vs/basic-languages/clojure/clojure.contribution";
import "monaco-editor/esm/vs/basic-languages/fsharp/fsharp.contribution";
// JSON（ハイライトは language service 側にのみ存在。worker は小型）
import "monaco-editor/esm/vs/language/json/monaco.contribution";
import Editor, { loader } from "@monaco-editor/react";

// CDN ではなくローカル同梱の monaco を使う（オフライン / CSP 対応）。
loader.config({ monaco: monacoEditor });

type Props = {
  language: string;
  value: string;
  onChange: (value: string) => void;
};

export default function CodeEditor({ language, value, onChange }: Props) {
  return (
    <Editor
      height="100%"
      language={language}
      value={value}
      theme="vs-dark"
      onChange={(v) => onChange(v ?? "")}
      options={{
        fontSize: 11,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: "on",
        lineNumbers: "on",
        renderWhitespace: "none",
        automaticLayout: true,
      }}
    />
  );
}
