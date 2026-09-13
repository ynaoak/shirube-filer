# shirube-filer

Tauri v2 + React + Rust で作るクロスプラットフォーム高機能ファイラー。
Tablacus Explorer にインスパイアされた高いカスタマイズ性と拡張性を持ち、Windows / macOS / Linux に対応します。

> **ライセンス**: ソース公開（source-available）。本体は [PolyForm Noncommercial 1.0.0](LICENSE)
> （非商用は自由に利用・改変・再配布可）、`desktop/addons/` は [MIT](LICENSE-MIT)。
> 詳細は [LICENSING.md](LICENSING.md) を参照してください。

## ダウンロード

ビルド済みのアプリは [Releases](https://github.com/ynaoak/shirube-filer/releases/latest) から入手できます。
インストーラ版はアプリ内から自動アップデートできます（設定 > アップデート）。

| OS | ファイル | 用途 |
| --- | --- | --- |
| Windows | `*-setup.exe` | インストーラ（推奨） |
| Windows | `*.msi` | MSI インストーラ |
| Windows | `*portable.zip` | ポータブル版（インストール不要・自動アップデートなし） |
| macOS (Apple Silicon) | `*_aarch64.dmg` | ディスクイメージ |
| macOS (Intel) | `*_x64.dmg` | ディスクイメージ |
| Linux | `*.AppImage` | 推奨 |
| Linux | `*.deb` / `*.rpm` | Debian・Ubuntu / Fedora・RHEL パッケージ |

コード署名をしていないため、初回起動時に OS の警告が出ることがあります
（Windows SmartScreen は「詳細情報 → 実行」、macOS は右クリック →「開く」）。

## 主な機能

- 自由なペイン分割・タブグループ（レイアウトは JSON/YAML/XML で保存・共有）
- Rust 製の高速ファイル操作（コピー/移動/削除/圧縮、操作キュー、アンドゥ/リドゥ）
- 高速インデックス検索、Grep 全文検索、フォルダ比較、重複検出
- プレビュー（テキスト/Markdown/画像/PDF/動画/音声/HEX/画像EXIF）
- ファイルタグ付け・タグ横断検索、カラーラベル
- ターミナル統合（PTY、カレントパス同期）
- クラウド連携アドオン（S3 / Box / Dropbox / GCS / Google Drive / OneDrive / SFTP / WebDAV）
- テーマ＋テーマエディタ、キーバインド再割り当て、コマンドパレット、アドオンシステム

## ソースからビルド

前提: [Node.js 22+](https://nodejs.org/)、[pnpm 10](https://pnpm.io/)、[Rust（stable）](https://rustup.rs/)、
各 OS の [Tauri v2 前提パッケージ](https://v2.tauri.app/start/prerequisites/)

```sh
cd desktop
pnpm install
pnpm tauri dev      # 開発起動
pnpm tauri build    # インストーラ生成（desktop/src-tauri/target/release/bundle/）
```

クラウド連携（Google Drive / Box など）の OAuth クライアントはビルド時の環境変数で埋め込みます。
`desktop/src-tauri/.cargo/config.toml.example` を参照してください（未設定でもその連携以外は動作します）。

| パス | 内容 |
| --- | --- |
| `desktop/` | アプリ本体（`src/` フロントエンド・`src-tauri/` Rust・`addons/` アドオン・`e2e/` テスト） |
| `.github/` | リリースビルド（`workflows/release.yml`） |

## このリポジトリについて

開発は非公開リポジトリで行い、リリースごとにソースをこのリポジトリへ反映しています。
リリースのビルドはこのリポジトリの GitHub Actions（`.github/workflows/release.yml`）で行われます。
不具合報告・要望は [Issues](https://github.com/ynaoak/shirube-filer/issues) へお願いします。
