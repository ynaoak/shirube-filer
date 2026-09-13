import { useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { useTranslation } from "react-i18next";
import Icon from "./Icon";
import { checkForUpdate, type UpdateCheckResult } from "../../lib/updater";

type InstallState =
  | { phase: "idle" }
  | { phase: "downloading"; percent: number | null }
  | { phase: "installed" }
  | { phase: "failed"; error: string };

/**
 * アップデート確認とアプリ内インストール。
 * 署名付きの更新（GitHub Releases の latest.json）があればダウンロード → インストール → 再起動まで行う。
 * updater が使えない場合は公開サイトの version.json で確認し、入手ページを開くボタンを出す。
 * （ストア版では非表示。SettingsModal 側で HAS_UPDATER により制御）
 */
export default function UpdateChecker() {
  const { t } = useTranslation();
  const [checking, setChecking] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [install, setInstall] = useState<InstallState>({ phase: "idle" });

  const runCheck = async () => {
    setChecking(true);
    setError(null);
    setResult(null);
    setInstall({ phase: "idle" });
    try {
      setCurrent(await getVersion().catch(() => null));
      setResult(await checkForUpdate());
    } catch (e) {
      setError(String(e));
    } finally {
      setChecking(false);
    }
  };

  const runInstall = async () => {
    if (result?.kind !== "installable") return;
    let total = 0;
    let received = 0;
    setInstall({ phase: "downloading", percent: null });
    try {
      // Windows ではインストーラ起動時にアプリが終了する（以降の処理には到達しない）
      await result.update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          received += event.data.chunkLength;
          setInstall({ phase: "downloading", percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null });
        }
      });
      setInstall({ phase: "installed" });
    } catch (e) {
      setInstall({ phase: "failed", error: String(e) });
    }
  };

  const busy = checking || install.phase === "downloading";
  const latest = result?.kind === "installable" ? result.update.version : result?.kind === "manifest" ? result.info.latest : null;
  const notes = result?.kind === "installable" ? result.update.body ?? "" : result?.kind === "manifest" ? result.info.notes : "";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={runCheck}
          disabled={busy}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded disabled:opacity-50"
          style={{ border: "1px solid var(--kf-border)", color: "var(--kf-text-primary)" }}
        >
          <Icon name={checking ? "progress_activity" : "system_update"} size={14} className={checking ? "animate-spin" : ""} />
          {t("settings.checkUpdate")}
        </button>
        {current && (
          <span style={{ color: "var(--kf-text-muted)", fontSize: "0.85rem" }}>
            {t("settings.currentVersion", { version: current })}
          </span>
        )}
      </div>

      {error && (
        <div style={{ color: "#fca5a5", fontSize: "0.85rem" }}>{t("settings.updateCheckFailed", { error })}</div>
      )}

      {result?.kind === "upToDate" && (
        <div className="flex items-center gap-1.5" style={{ color: "var(--kf-success, #34d399)", fontSize: "0.85rem" }}>
          <Icon name="check_circle" size={14} />
          {t("settings.upToDate")}
        </div>
      )}

      {latest && (
        <div
          className="flex flex-col gap-2 rounded p-3"
          style={{ border: "1px solid var(--kf-accent)", backgroundColor: "color-mix(in srgb, var(--kf-accent) 10%, transparent)" }}
        >
          <div style={{ color: "var(--kf-text-primary)" }}>
            {t("settings.updateAvailable", { version: latest })}
          </div>
          {notes && (
            <div style={{ color: "var(--kf-text-muted)", fontSize: "0.85rem", whiteSpace: "pre-wrap" }}>{notes}</div>
          )}

          {result?.kind === "manifest" && (
            <div>
              <button
                onClick={() => openUrl(result.info.url).catch(() => {})}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded"
                style={{ backgroundColor: "var(--kf-accent)", color: "var(--kf-accent-fg, #fff)" }}
              >
                <Icon name="download" size={14} />
                {t("settings.openDownloadPage")}
              </button>
            </div>
          )}

          {result?.kind === "installable" && (
            <div className="flex items-center gap-3 flex-wrap">
              {install.phase === "installed" ? (
                <>
                  <span style={{ color: "var(--kf-text-primary)", fontSize: "0.85rem" }}>{t("settings.updateInstalled")}</span>
                  <button
                    onClick={() => relaunch().catch((e) => setInstall({ phase: "failed", error: String(e) }))}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded"
                    style={{ backgroundColor: "var(--kf-accent)", color: "var(--kf-accent-fg, #fff)" }}
                  >
                    <Icon name="restart_alt" size={14} />
                    {t("settings.relaunchToUpdate")}
                  </button>
                </>
              ) : (
                <button
                  onClick={runInstall}
                  disabled={busy}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded disabled:opacity-50"
                  style={{ backgroundColor: "var(--kf-accent)", color: "var(--kf-accent-fg, #fff)" }}
                >
                  <Icon
                    name={install.phase === "downloading" ? "progress_activity" : "download"}
                    size={14}
                    className={install.phase === "downloading" ? "animate-spin" : ""}
                  />
                  {install.phase === "downloading"
                    ? install.percent === null
                      ? t("settings.downloadingUpdate")
                      : t("settings.downloadingUpdatePercent", { percent: install.percent })
                    : t("settings.installUpdate")}
                </button>
              )}
            </div>
          )}

          {install.phase === "failed" && (
            <div style={{ color: "#fca5a5", fontSize: "0.85rem" }}>{t("settings.updateInstallFailed", { error: install.error })}</div>
          )}
        </div>
      )}
    </div>
  );
}
