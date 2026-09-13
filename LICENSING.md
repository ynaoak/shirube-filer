# ライセンスと利用条件 / Licensing

shirube-filer は「ソース公開（source-available）＋有料販売」のモデルを採用しています。
**ソースは読める・学べる・個人や非営利では使える**一方で、**他者が競合ビルドを商用販売することは禁止**し、
公式の署名済みアプリをアプリストアで有料販売します。

This project uses a **source-available + paid** model. The source is published
so anyone can read, learn from, and use it for noncommercial purposes — while
reselling competing builds commercially is not permitted. The official signed
app is sold through app stores.

---

## 適用されるライセンス一覧

| 対象 | ライセンス | 内容 |
| ---- | ---- | ---- |
| **アプリ本体のソース**（v0.1.13〜） | [PolyForm Noncommercial 1.0.0](LICENSE) | 非商用なら自由に利用・改変・再配布可。商用利用には別途許諾が必要。 |
| **過去リリース**（〜v0.1.12） | [MIT](LICENSE-MIT) | 既に MIT で公開済み。そのバージョンは MIT のまま（遡及変更は不可）。 |
| **プラグイン** (`addons/`) | [MIT](LICENSE-MIT) | 本体とは別扱い。商用を含めて自由に利用・改変・再配布可（プラグインを誰でも作れるようにするため）。 |
| **公式バイナリ**（App Store / Microsoft Store 版） | 各ストアの EULA ＋本プロジェクトの商用条件 | 購入者には**商用利用を含む**利用権を付与。 |

> なぜ「非商用ソース」と「商用バイナリ」が両立するのか:
> PolyForm Noncommercial が制限するのは **ソースコードの商用利用・再配布**です。
> 一方、ストアで購入したバイナリには、ストア EULA／本プロジェクトの商用条件によって
> **業務利用を含む使用権**が付与されます。つまり「会社でアプリを買って業務に使う」のは OK、
> 「ソースを使って競合製品を作って売る」のは別途許諾が必要、という切り分けです。

---

## ケース別の早見表

| やりたいこと | 可否 | 必要なこと |
| ---- | ---- | ---- |
| 個人や趣味でソースからビルドして使う | ✅ | なし（非商用） |
| 学校・非営利団体・公的機関で使う | ✅ | なし（非商用組織として許可） |
| バグ修正・改造して PR を送る | ✅ | なし |
| 業務（会社の仕事）でアプリを使う | ✅ | 公式バイナリをストアで購入（商用利用権つき） |
| ソースを使って自社製品・有償サービスを作る／再販する | ⚠️ | 別途**商用ライセンス**の取得（お問い合わせ） |
| 公式と競合する有料ビルドを配布する | ❌ | 不可（商用ライセンスでも原則許可しない） |

## 商用ライセンスのお問い合わせ

ソースを商用目的（社内製品への組み込み、再販、有償 SaaS など）で利用したい場合は、
個別の商用ライセンスを発行します。GitHub Issues または下記までご連絡ください。

- お問い合わせ: <https://github.com/ynaoak/shirube-filer/issues>
- （メール等の窓口を設ける場合はここに追記）

## 開発を支援する（任意）

販売とは別に、開発の継続を**任意で支援**いただける GitHub Sponsors を用意しています
（[.github/FUNDING.yml](.github/FUNDING.yml)）。スポンサーは義務ではなく、アプリの購入とも独立しています。

---

### 補足: サードパーティ依存のライセンス

本体が依存する OSS は MIT / Apache-2.0 / BSD など商用配布可能なライセンスで構成しています
（Tauri は MIT/Apache-2.0、React は MIT 等）。配布バイナリには各依存のライセンス表記を同梱します
（サードパーティ表記の生成手順は [docs/product/monetization.md](docs/product/monetization.md) を参照）。
