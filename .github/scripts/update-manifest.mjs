#!/usr/bin/env node
/**
 * Release の添付ファイル（インストーラ + .sig）から updater 用の latest.json を組み立てる。
 *
 * tauri-action が書く latest.json は OS ごとに 1 形式しか持たないため、ここで
 * {os}-{arch}-{installer} のキーまで展開する。tauri-plugin-updater はこの形式別キーを
 * 先に引くので、NSIS で入れた環境には NSIS、MSI には MSI、deb には deb が配られる
 * （形式を混ぜると同じアプリが二重に登録される）。
 *
 * usage: node update-manifest.mjs --repo owner/name --tag vX.Y.Z --sigs <dir> --assets-list <file> --out latest.json
 *   --sigs        Release の .sig 添付を添付名のまま置いたディレクトリ（本体は不要）
 *   --assets-list Release の全添付ファイル名（1 行 1 件）
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, all) => (cur.startsWith("--") ? [...acc, [cur.slice(2), all[i + 1]]] : acc), []),
);
for (const k of ["repo", "tag", "sigs", "assets-list", "out"]) {
  if (!args[k]) {
    console.error(`missing --${k}`);
    process.exit(2);
  }
}

const names = readFileSync(args["assets-list"], "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const version = args.tag.replace(/^v/, "");
const base = `https://github.com/${args.repo}/releases/download/${args.tag}`;

/** 署名付きの添付ファイルを 1 件探す（.sig が無いものは updater で使えないので除外） */
function find(test) {
  const hit = names.find((n) => !n.endsWith(".sig") && test(n) && names.includes(`${n}.sig`));
  if (!hit) return null;
  const sigPath = join(args.sigs, `${hit}.sig`);
  if (!existsSync(sigPath)) throw new Error(`signature not downloaded: ${sigPath}`);
  return { signature: readFileSync(sigPath, "utf8").trim(), url: `${base}/${encodeURIComponent(hit)}` };
}

const nsis = find((n) => n.endsWith("-setup.exe"));
const msi = find((n) => n.endsWith(".msi"));
const macArm = find((n) => n.endsWith(".app.tar.gz") && /aarch64/.test(n));
const macX64 = find((n) => n.endsWith(".app.tar.gz") && /x64|x86_64/.test(n));
const appimage = find((n) => n.endsWith(".AppImage"));
const deb = find((n) => n.endsWith(".deb"));
const rpm = find((n) => n.endsWith(".rpm"));

const platforms = {};
const put = (key, entry) => { if (entry) platforms[key] = entry; };
// 形式なしキーは「その OS の既定の配布形式」（ポータブル等の不明な入れ方の場合に使われる）
put("windows-x86_64", nsis ?? msi);
put("windows-x86_64-nsis", nsis);
put("windows-x86_64-msi", msi);
put("darwin-aarch64", macArm);
put("darwin-aarch64-app", macArm);
put("darwin-x86_64", macX64);
put("darwin-x86_64-app", macX64);
put("linux-x86_64", appimage);
put("linux-x86_64-appimage", appimage);
put("linux-x86_64-deb", deb);
put("linux-x86_64-rpm", rpm);

if (Object.keys(platforms).length === 0) {
  console.error("no signed installers found in the release — was the build made with tauri.updater.conf.json?");
  process.exit(1);
}

const manifest = {
  version,
  notes: `shirube-filer ${args.tag}`,
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  platforms,
};
writeFileSync(args.out, JSON.stringify(manifest, null, 2) + "\n");
console.log(`latest.json: ${Object.keys(platforms).join(", ")}`);
