import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import Icon from "../common/Icon";
import EmptyState from "../common/EmptyState";
import ContextMenu from "../common/ContextMenu";
import SkeletonList from "../common/SkeletonList";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { HAS_BUILTIN_SERVER, HAS_TERMINAL } from "../../buildConfig";
import { genId } from "../../store/layoutStore";
import { TerminalTab } from "../../types/layout";
import {
  manifestIcon,
  samePath,
  taskIcon,
  taskKey,
  type ProjectManifest,
  type ProjectTask,
  type ProjectTasks,
} from "../../lib/projectTasks";
import {
  interruptTerminal,
  queueTerminalCommand,
  sendTerminalCommand,
  typeTerminalCommand,
} from "../../lib/terminalCommand";
import { disposeTerminal } from "../../lib/terminalRegistry";
import {
  markTaskStarted,
  markTaskStopped,
  pruneRunningTasks,
  useRunningTasks,
} from "../../store/taskRunnerStore";
import { showToast } from "../../lib/toast";
import {
  DEFAULT_PORT,
  MAX_PRESETS,
  listStaticServers,
  loadServerPresets,
  newPresetId,
  parsePort,
  presetLabel,
  removePreset,
  saveServerPresets,
  startStaticServer,
  stopStaticServer,
  upsertPreset,
  type ServerPreset,
  type StaticServerInfo,
} from "../../lib/staticServer";

// xterm は重いので、パネルを開いたときだけ読み込む（PaneContainer と同じ扱い）。
const Terminal = lazy(() => import("../viewers/Terminal"));

type Props = {
  /** いま見ているフォルダ（ここから上位へ遡ってマニフェストを探す） */
  currentPath: string;
  /** 表示のオン/オフ。閉じても実行中のシェルを殺さないため、非表示で保持する */
  hidden?: boolean;
  onClose: () => void;
};

const MIN_WIDTH = 240;
const MAX_WIDTH = 900;
const DEFAULT_WIDTH = 320;
const WIDTH_KEY = "kf-task-panel-width";

/** シェル領域の高さ（パネル全体に対する %）。既定は上 60% がタスク一覧。 */
const MIN_SHELL_RATIO = 15;
const MAX_SHELL_RATIO = 80;
const DEFAULT_SHELL_RATIO = 40;
const SHELL_RATIO_KEY = "kf-task-panel-shell-ratio";

/** Ctrl+C が効いてから再実行するまでの待ち時間。 */
const RESTART_DELAY_MS = 400;

const PORT_KEY = "kf-task-panel-server-port";

function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function readStoredNumber(key: string, fallback: number, min: number, max: number): number {
  const saved = localStorage.getItem(key);
  const parsed = saved ? parseInt(saved, 10) : NaN;
  return isNaN(parsed) ? fallback : Math.min(max, Math.max(min, parsed));
}

/** パネル内のシェル。タスクを流すフォルダごとに 1 つ持つ。 */
type PanelShell = {
  terminalId: string;
  cwd: string;
};

export default function TaskRunnerPanel({ currentPath, hidden = false, onClose }: Props) {
  const { t } = useTranslation();
  const running = useRunningTasks();
  const [data, setData] = useState<ProjectTasks | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shell, setShell] = useState<PanelShell | null>(null);
  const restartTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // ── パネル幅 / シェル領域の高さ（どちらもドラッグで調整して保存する） ──
  const [width, setWidth] = useState(() =>
    readStoredNumber(WIDTH_KEY, DEFAULT_WIDTH, MIN_WIDTH, MAX_WIDTH)
  );
  const [shellRatio, setShellRatio] = useState(() =>
    readStoredNumber(SHELL_RATIO_KEY, DEFAULT_SHELL_RATIO, MIN_SHELL_RATIO, MAX_SHELL_RATIO)
  );
  const widthRef = useRef(width);
  widthRef.current = width;
  const bodyRef = useRef<HTMLDivElement>(null);

  const startWidthDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = widthRef.current;
    const onMove = (ev: MouseEvent) => {
      // パネルは右端にあるので、左へ動かすと広がる
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + (startX - ev.clientX)));
      setWidth(next);
      localStorage.setItem(WIDTH_KEY, String(next));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  const startShellDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const body = bodyRef.current;
    if (!body) return;
    const onMove = (ev: MouseEvent) => {
      const rect = body.getBoundingClientRect();
      if (rect.height === 0) return;
      const fromBottom = ((rect.bottom - ev.clientY) / rect.height) * 100;
      const next = Math.round(
        Math.min(MAX_SHELL_RATIO, Math.max(MIN_SHELL_RATIO, fromBottom))
      );
      setShellRatio(next);
      localStorage.setItem(SHELL_RATIO_KEY, String(next));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  // ── タスクの検出 ────────────────────────────────────────────────────
  const detect = useCallback(async () => {
    if (!currentPath) {
      setData(null);
      return;
    }
    setLoading(true);
    try {
      const found = await invoke<ProjectTasks>("detect_project_tasks", {
        dir: currentPath,
        searchAncestors: true,
      });
      setData(found);
      setError(null);
    } catch (e) {
      setData(null);
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [currentPath]);

  // フォルダを移動するたびに走るので、連続移動では最後の 1 回だけ実行する
  useEffect(() => {
    if (hidden) return;
    const timer = setTimeout(() => {
      void detect();
    }, 150);
    return () => clearTimeout(timer);
  }, [detect, hidden]);

  // ローカルフォルダを開いていればシェルを用意する（マニフェストの有無は問わない）。
  // 以降はタスクを実行するまで作り替えない: フォルダを見て回るだけで、動いている
  // シェル（開発サーバーなど）を落とさないため。
  const shellRoot = data?.isDir ? data.dir : null;
  useEffect(() => {
    if (!HAS_TERMINAL || hidden || !shellRoot || shell) return;
    setShell({ terminalId: genId(), cwd: shellRoot });
  }, [shellRoot, shell, hidden]);

  // 実行中の印は、いまのシェルに紐づくものだけ残す
  useEffect(() => {
    pruneRunningTasks(new Set(shell ? [shell.terminalId] : []));
  }, [shell]);

  useEffect(() => {
    const timers = restartTimersRef.current;
    return () => {
      timers.forEach(clearTimeout);
    };
  }, []);

  const runningByKey = useMemo(() => new Map(running.map((r) => [r.key, r])), [running]);

  /**
   * シェル領域でコマンドを流す。フォルダが違えばそのフォルダのシェルを開き直す。
   *
   * `submit` を false にすると Enter を送らず入力欄に置くだけにする
   * （引数を足してから実行したいとき。実行していないので「実行中」にもしない）。
   */
  const startTask = useCallback(
    (manifest: ProjectManifest, task: ProjectTask, submit = true) => {
      if (!HAS_TERMINAL || !data) return;
      const dir = data.dir;
      const key = taskKey(manifest, task);

      const markStarted = (terminalId: string) => {
        if (!task.longRunning || !submit) return;
        markTaskStarted({
          key,
          terminalId,
          label: task.label,
          command: task.command,
          startedAt: Date.now(),
        });
      };

      if (shell && samePath(shell.cwd, dir)) {
        const write = submit ? sendTerminalCommand : typeTerminalCommand;
        write(shell.terminalId, task.command)
          .then(() => markStarted(shell.terminalId))
          .catch((e) => showToast(t("taskPanel.runFailed", { error: String(e) })));
        return;
      }

      // 新しいシェルは起動してからでないと書き込めないので、コマンドを預けて
      // Terminal 側に送ってもらう。
      //
      // 前のシェルはアンマウントでは閉じない（ペインの組み替えでプロセスが
      // 死なないよう、実体は React の外に置いてある）。別フォルダのシェルへ
      // 切り替えるこの場面では、持ち主である自分で片付ける。
      const previous = shell?.terminalId;
      const terminalId = genId();
      queueTerminalCommand(terminalId, task.command, submit);
      setShell({ terminalId, cwd: dir });
      if (previous) disposeTerminal(previous);
      markStarted(terminalId);
    },
    [data, shell, t]
  );

  const stopTask = useCallback((key: string, terminalId: string) => {
    interruptTerminal(terminalId).catch(() => {});
    markTaskStopped(key);
  }, []);

  const restartTask = useCallback(
    (manifest: ProjectManifest, task: ProjectTask, terminalId: string) => {
      interruptTerminal(terminalId).catch(() => {});
      const timer = setTimeout(() => {
        sendTerminalCommand(terminalId, task.command)
          .then(() => {
            markTaskStarted({
              key: taskKey(manifest, task),
              terminalId,
              label: task.label,
              command: task.command,
              startedAt: Date.now(),
            });
          })
          .catch((e) => {
            markTaskStopped(taskKey(manifest, task));
            showToast(t("taskPanel.runFailed", { error: String(e) }));
          });
      }, RESTART_DELAY_MS);
      restartTimersRef.current.push(timer);
    },
    [t]
  );

  // ── 組み込みサーバー（登録した「フォルダ＋ポート」を使い回す） ──────
  const [servers, setServers] = useState<StaticServerInfo[]>([]);
  const [presets, setPresets] = useState<ServerPreset[]>([]);
  const [showServerForm, setShowServerForm] = useState(false);
  const [formRoot, setFormRoot] = useState("");
  const [formPort, setFormPort] = useState(
    () => localStorage.getItem(PORT_KEY) ?? String(DEFAULT_PORT)
  );
  const [formLiveReload, setFormLiveReload] = useState(true);
  const [serverBusy, setServerBusy] = useState(false);

  // パネルを開き直しても、動いている配信と登録を拾い直す
  useEffect(() => {
    if (hidden || !HAS_BUILTIN_SERVER) return;
    listStaticServers()
      .then(setServers)
      .catch(() => setServers([]));
    loadServerPresets()
      .then(setPresets)
      .catch(() => setPresets([]));
  }, [hidden]);

  /** 登録フォームの初期値。いま見ているフォルダを既定にする。 */
  const currentDir = data?.isDir ? currentPath : null;
  const openServerForm = useCallback(() => {
    setFormRoot((prev) => prev || currentDir || "");
    setShowServerForm(true);
  }, [currentDir]);

  const pickServerRoot = useCallback(async () => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        defaultPath: formRoot || currentDir || undefined,
      });
      if (typeof selected === "string") setFormRoot(selected);
    } catch {
      /* キャンセルは何もしない */
    }
  }, [formRoot, currentDir]);

  const persistPresets = useCallback(
    (next: ServerPreset[]) => {
      setPresets(next);
      saveServerPresets(next).catch((e) => showToast(String(e)));
    },
    []
  );

  /** フォームの内容を登録に足す（同じフォルダ＋ポートなら差し替え）。 */
  const addPreset = useCallback(() => {
    const root = formRoot.trim();
    if (!root) {
      showToast(t("taskPanel.serverNoFolder"));
      return;
    }
    const port = parsePort(formPort);
    if (port === null) {
      showToast(t("taskPanel.serverPortInvalid"));
      return;
    }
    if (presets.length >= MAX_PRESETS) {
      showToast(t("taskPanel.serverTooMany", { max: MAX_PRESETS }));
      return;
    }
    localStorage.setItem(PORT_KEY, String(port));
    persistPresets(
      upsertPreset(presets, {
        id: newPresetId(),
        label: "",
        root,
        port,
        liveReload: formLiveReload,
      })
    );
    setShowServerForm(false);
  }, [formRoot, formPort, formLiveReload, presets, persistPresets, t]);

  const deletePreset = useCallback(
    (id: string) => persistPresets(removePreset(presets, id)),
    [presets, persistPresets]
  );

  /** 登録のホットリロードを切り替える（次に起動したときから効く）。 */
  const toggleLiveReload = useCallback(
    (preset: ServerPreset) =>
      persistPresets(
        presets.map((p) => (p.id === preset.id ? { ...p, liveReload: !p.liveReload } : p))
      ),
    [presets, persistPresets]
  );

  const startServer = useCallback(
    (root: string, port: number, liveReload: boolean) => {
      setServerBusy(true);
      startStaticServer(root, port, liveReload)
        .then((info) => {
          setServers((prev) => [...prev.filter((s) => s.port !== info.port), info]);
          showToast(t("taskPanel.serverStarted", { url: info.url }), "success");
        })
        .catch((e) => showToast(String(e)))
        .finally(() => setServerBusy(false));
    },
    [t]
  );

  const stopServer = useCallback((port: number) => {
    setServerBusy(true);
    stopStaticServer(port)
      .then(() => setServers((prev) => prev.filter((s) => s.port !== port)))
      .catch((e) => showToast(String(e)))
      .finally(() => setServerBusy(false));
  }, []);

  /** 登録に対応する、動いている配信（同じフォルダ・同じポートのもの）。 */
  const runningFor = useCallback(
    (preset: ServerPreset) =>
      servers.find((s) => s.port === preset.port && samePath(s.root, preset.root)) ?? null,
    [servers]
  );

  /** 登録に無いまま動いている配信（登録を消したあとなど）。止め忘れに気付けるよう出す。 */
  const unlistedServers = useMemo(
    () =>
      servers.filter(
        (s) => !presets.some((p) => p.port === s.port && samePath(p.root, s.root))
      ),
    [servers, presets]
  );

  // ── コマンドのコンテキストメニュー ──────────────────────────────────
  // 行を右クリック、またはホバーで出る「⋮」から開く。実行ボタンだけでは
  // 足りない操作（引数を足して実行、コピー）をここに集める。
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    manifest: ProjectManifest;
    task: ProjectTask;
  } | null>(null);

  const copyCommand = useCallback(
    (command: string) => {
      navigator.clipboard
        .writeText(command)
        .then(() => showToast(t("taskPanel.copied"), "success"))
        .catch(() => showToast(t("taskPanel.copyFailed")));
    },
    [t]
  );

  const menuItems = useMemo(() => {
    if (!menu) return [];
    const { manifest, task } = menu;
    const active = runningByKey.get(taskKey(manifest, task));
    const items: React.ComponentProps<typeof ContextMenu>["items"] = [
      { type: "label", label: task.command },
      {
        type: "item",
        label: t("taskPanel.run"),
        icon: "play_arrow",
        emphasis: true,
        disabled: !HAS_TERMINAL,
        action: () => startTask(manifest, task),
      },
    ];
    if (active) {
      items.push({
        type: "item",
        label: t("taskPanel.restart"),
        icon: "restart_alt",
        action: () => restartTask(manifest, task, active.terminalId),
      });
      items.push({
        type: "item",
        label: t("taskPanel.stop"),
        icon: "stop_circle",
        iconColor: "var(--kf-error)",
        action: () => stopTask(taskKey(manifest, task), active.terminalId),
      });
    }
    items.push({ type: "separator" });
    items.push({
      type: "item",
      label: t("taskPanel.typeIntoShell"),
      icon: "keyboard",
      disabled: !HAS_TERMINAL,
      action: () => startTask(manifest, task, false),
    });
    items.push({
      type: "item",
      label: t("taskPanel.copyCommand"),
      icon: "content_copy",
      action: () => copyCommand(task.command),
    });
    return items;
  }, [menu, runningByKey, startTask, restartTask, stopTask, copyCommand, t]);

  const manifests = data?.manifests ?? [];
  const shellTab: TerminalTab | null = shell
    ? {
        id: shell.terminalId,
        paneType: "terminal",
        title: baseName(shell.cwd),
        cwd: shell.cwd,
        terminalId: shell.terminalId,
      }
    : null;

  return (
    <div
      className="flex-shrink-0 flex flex-col border-l text-xs overflow-hidden relative"
      style={{
        width,
        display: hidden ? "none" : undefined,
        backgroundColor: "var(--kf-bg-primary)",
        borderColor: "var(--kf-border)",
        color: "var(--kf-text-primary)",
      }}
    >
      {/* 幅のリサイズハンドル */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize z-10 hover:bg-blue-500 hover:opacity-60"
        style={{ touchAction: "none" }}
        onMouseDown={startWidthDrag}
      />

      {/* ヘッダー */}
      <div
        className="flex items-center gap-2 px-3 py-2 border-b shrink-0"
        style={{ backgroundColor: "var(--kf-bg-secondary)", borderColor: "var(--kf-border)" }}
      >
        <Icon name="play_circle" size={14} style={{ color: "var(--kf-text-muted)" }} />
        <span className="flex-1 truncate font-medium">{t("taskPanel.title")}</span>
        {loading && (
          <Icon
            name="progress_activity"
            size={13}
            className="animate-spin"
            style={{ color: "var(--kf-info)" }}
          />
        )}
        <button
          onClick={() => void detect()}
          className="flex items-center opacity-50 hover:opacity-100 transition-opacity"
          title={t("taskPanel.refresh")}
        >
          <Icon name="refresh" size={14} />
        </button>
        <button
          onClick={onClose}
          className="flex items-center opacity-50 hover:opacity-100 transition-opacity"
          title={t("common.close")}
        >
          <Icon name="close" size={14} />
        </button>
      </div>

      {/* 検出したプロジェクト */}
      {manifests.length > 0 && data && (
        <div
          className="px-3 py-1.5 border-b shrink-0 flex items-center gap-1.5"
          style={{ borderColor: "var(--kf-border-soft)", color: "var(--kf-text-secondary)" }}
          title={data.dir}
        >
          <Icon name="folder" size={12} style={{ flexShrink: 0 }} />
          <span className="truncate font-mono">{baseName(data.dir)}</span>
          {data.fromAncestor && (
            <span
              className="shrink-0 px-1 rounded"
              style={{ backgroundColor: "var(--kf-bg-tertiary)", color: "var(--kf-text-muted)" }}
              title={data.dir}
            >
              {t("taskPanel.fromAncestor")}
            </span>
          )}
        </div>
      )}

      {/* 本体: 上=タスク一覧（スクロール） / 下=シェル */}
      <div ref={bodyRef} className="flex-1 min-h-0 flex flex-col">
        <div className="flex-1 min-h-0 overflow-y-auto">
          {/* 組み込みサーバー: 登録した「フォルダ＋ポート」を使い回す。
              マニフェストが無いフォルダでも使える。 */}
          {HAS_BUILTIN_SERVER && (
            <div className="px-2 py-1.5 border-b" style={{ borderColor: "var(--kf-border-soft)" }}>
              <div className="flex items-center gap-1.5">
                <Icon name="dns" size={12} style={{ color: "var(--kf-text-muted)" }} />
                <span className="flex-1 truncate" style={{ color: "var(--kf-text-secondary)" }}>
                  {t("taskPanel.server")}
                </span>
                <button
                  className="shrink-0 opacity-70 hover:opacity-100"
                  title={t("taskPanel.serverAdd")}
                  aria-label={t("taskPanel.serverAdd")}
                  onClick={() => (showServerForm ? setShowServerForm(false) : openServerForm())}
                >
                  <Icon name={showServerForm ? "close" : "add"} size={14} />
                </button>
              </div>

              {/* 登録フォーム: ルートは入力かフォルダ選択で決める */}
              {showServerForm && (
                <div className="flex items-center gap-1 mt-1">
                  <input
                    value={formRoot}
                    onChange={(e) => setFormRoot(e.target.value)}
                    placeholder={t("taskPanel.serverRootPlaceholder")}
                    aria-label={t("taskPanel.serverRoot")}
                    title={formRoot || t("taskPanel.serverRoot")}
                    className="flex-1 min-w-0 bg-transparent outline-none border rounded px-1 font-mono"
                    style={{ borderColor: "var(--kf-border)", color: "var(--kf-text-primary)" }}
                  />
                  <button
                    className="shrink-0 opacity-70 hover:opacity-100"
                    title={t("taskPanel.serverPickFolder")}
                    aria-label={t("taskPanel.serverPickFolder")}
                    onClick={() => void pickServerRoot()}
                  >
                    <Icon name="folder_open" size={14} />
                  </button>
                  <input
                    value={formPort}
                    onChange={(e) => setFormPort(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addPreset();
                    }}
                    inputMode="numeric"
                    aria-label={t("taskPanel.serverPort")}
                    title={t("taskPanel.serverPort")}
                    className="bg-transparent outline-none border rounded px-1 text-right font-mono"
                    style={{
                      width: 52,
                      borderColor: "var(--kf-border)",
                      color: "var(--kf-text-primary)",
                    }}
                  />
                  <button
                    className="shrink-0 hover:opacity-100"
                    title={
                      formLiveReload
                        ? t("taskPanel.serverLiveReloadOn")
                        : t("taskPanel.serverLiveReloadOff")
                    }
                    aria-label={t("taskPanel.serverLiveReload")}
                    aria-pressed={formLiveReload}
                    style={{
                      color: formLiveReload ? "var(--kf-info)" : "var(--kf-text-muted)",
                      opacity: formLiveReload ? 1 : 0.6,
                    }}
                    onClick={() => setFormLiveReload((v) => !v)}
                  >
                    <Icon name={formLiveReload ? "bolt" : "flash_off"} size={14} />
                  </button>
                  <button
                    className="kf-btn kf-btn-secondary shrink-0"
                    style={{ height: 22, padding: "0 8px", fontSize: 11 }}
                    title={t("taskPanel.serverRegister")}
                    onClick={addPreset}
                  >
                    {t("taskPanel.serverRegister")}
                  </button>
                </div>
              )}

              {presets.length === 0 && !showServerForm && (
                <div className="mt-1" style={{ color: "var(--kf-text-muted)" }}>
                  {t("taskPanel.serverNoPreset")}
                </div>
              )}

              {/* 登録一覧: ▶ で起動、■ で停止、URL クリックでブラウザ */}
              {presets.map((preset) => {
                const running = runningFor(preset);
                return (
                  <div key={preset.id} className="flex items-center gap-1.5 mt-1">
                    {/* アイコンだけだと何が起きるか分からないので、操作名を添える */}
                    {running ? (
                      <button
                        className="kf-btn kf-btn-danger shrink-0"
                        style={{ height: 22, padding: "0 8px", fontSize: 11 }}
                        title={t("taskPanel.serverStopHint", { dir: preset.root })}
                        disabled={serverBusy}
                        onClick={() => stopServer(preset.port)}
                      >
                        <Icon name="stop" size={14} />
                        {t("taskPanel.serverStopAction")}
                      </button>
                    ) : (
                      <button
                        className="kf-btn kf-btn-secondary shrink-0"
                        style={{ height: 22, padding: "0 8px", fontSize: 11 }}
                        title={t("taskPanel.serverStartHint", { dir: preset.root })}
                        disabled={serverBusy}
                        onClick={() => startServer(preset.root, preset.port, preset.liveReload)}
                      >
                        <Icon name="play_arrow" size={14} />
                        {t("taskPanel.serverStartAction")}
                      </button>
                    )}
                    {running ? (
                      <button
                        className="flex-1 min-w-0 truncate font-mono text-left"
                        style={{ color: "var(--kf-info)" }}
                        title={t("taskPanel.serverOpenHint", { dir: running.root })}
                        onClick={() => {
                          openUrl(running.url).catch(() =>
                            showToast(t("taskPanel.serverOpenFailed"))
                          );
                        }}
                      >
                        {running.url}
                      </button>
                    ) : (
                      <span className="flex-1 min-w-0 truncate" title={preset.root}>
                        {presetLabel(preset)}
                      </span>
                    )}
                    <span className="shrink-0 font-mono" style={{ color: "var(--kf-text-muted)" }}>
                      {preset.port}
                    </span>
                    <button
                      className="shrink-0 hover:opacity-100"
                      title={
                        preset.liveReload
                          ? t("taskPanel.serverLiveReloadOn")
                          : t("taskPanel.serverLiveReloadOff")
                      }
                      aria-label={t("taskPanel.serverLiveReload")}
                      aria-pressed={preset.liveReload}
                      style={{
                        color: preset.liveReload ? "var(--kf-info)" : "var(--kf-text-muted)",
                        opacity: preset.liveReload ? 1 : 0.5,
                      }}
                      onClick={() => toggleLiveReload(preset)}
                    >
                      <Icon name={preset.liveReload ? "bolt" : "flash_off"} size={13} />
                    </button>
                    <button
                      className="shrink-0 opacity-60 hover:opacity-100 transition-opacity"
                      title={t("taskPanel.serverRemove")}
                      aria-label={t("taskPanel.serverRemove")}
                      onClick={() => deletePreset(preset.id)}
                    >
                      <Icon name="delete" size={13} />
                    </button>
                  </div>
                );
              })}

              {/* 登録に無いまま動いている配信（登録を消したあとなど） */}
              {unlistedServers.map((server) => (
                <div key={`unlisted-${server.port}`} className="flex items-center gap-1.5 mt-1">
                  <button
                    className="kf-btn kf-btn-danger shrink-0"
                    style={{ height: 22, padding: "0 8px", fontSize: 11 }}
                    title={t("taskPanel.serverStopHint", { dir: server.root })}
                    disabled={serverBusy}
                    onClick={() => stopServer(server.port)}
                  >
                    <Icon name="stop" size={14} />
                    {t("taskPanel.serverStopAction")}
                  </button>
                  <button
                    className="flex-1 min-w-0 truncate font-mono text-left"
                    style={{ color: "var(--kf-info)" }}
                    title={t("taskPanel.serverOpenHint", { dir: server.root })}
                    onClick={() => {
                      openUrl(server.url).catch(() => showToast(t("taskPanel.serverOpenFailed")));
                    }}
                  >
                    {server.url}
                  </button>
                  <span className="shrink-0 font-mono" style={{ color: "var(--kf-text-muted)" }}>
                    {server.port}
                  </span>
                </div>
              ))}
            </div>
          )}

          {loading && manifests.length === 0 && <SkeletonList rows={6} twoLine />}

          {error && !loading && (
            <EmptyState icon="error" size={20} message={t("taskPanel.detectFailed")} hint={error} />
          )}

          {!loading && !error && manifests.length === 0 && (
            <EmptyState
              icon="playlist_add_check"
              size={20}
              message={t("taskPanel.noProject")}
              hint={t("taskPanel.noProjectHint")}
            />
          )}

          {manifests.map((manifest) => (
            <div key={manifest.file}>
              {/* マニフェスト見出し */}
              <div
                className="flex items-center gap-1.5 px-3 py-1 sticky top-0"
                style={{
                  backgroundColor: "var(--kf-bg-secondary)",
                  borderBottom: "1px solid var(--kf-border-soft)",
                  color: "var(--kf-text-secondary)",
                }}
                title={manifest.file}
              >
                <Icon name={manifestIcon(manifest.kind)} size={12} style={{ flexShrink: 0 }} />
                <span className="flex-1 truncate">{baseName(manifest.file)}</span>
                <span style={{ color: "var(--kf-text-muted)" }}>{manifest.tool}</span>
              </div>

              {manifest.tasks.map((task) => {
                const key = taskKey(manifest, task);
                const active = runningByKey.get(key);
                return (
                  <div
                    key={key}
                    className="kf-task-row flex items-center gap-1 px-1.5 py-0.5 group"
                    style={{ borderBottom: "1px solid var(--kf-border-soft)" }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({ x: e.clientX, y: e.clientY, manifest, task });
                    }}
                  >
                    {/* 主操作。行の広い面がそのまま実行ボタンになる
                        （小さなアイコンだけだと押せることに気付けない）。
                        実行中は押すと止まる。 */}
                    <button
                      className="kf-task-run flex items-center gap-2 flex-1 min-w-0 text-left py-1 rounded"
                      disabled={!HAS_TERMINAL}
                      title={
                        !HAS_TERMINAL
                          ? t("taskPanel.terminalUnavailable")
                          : active
                          ? t("taskPanel.stop")
                          : t("taskPanel.runHint", { command: task.command })
                      }
                      onClick={() =>
                        active ? stopTask(key, active.terminalId) : startTask(manifest, task)
                      }
                    >
                      <span
                        aria-hidden
                        className={`kf-run-chip${active ? " kf-run-chip--running" : ""}`}
                      >
                        <Icon name={active ? "stop" : "play_arrow"} size={16} />
                      </span>
                      <span className="flex flex-col min-w-0 flex-1">
                        <span className="truncate flex items-center gap-1">
                          <Icon
                            name={taskIcon(task.kind)}
                            size={11}
                            style={{ color: "var(--kf-text-muted)", flexShrink: 0 }}
                          />
                          <span className="truncate">{task.label}</span>
                          {active && (
                            <span className="shrink-0" style={{ color: "var(--kf-info)", fontSize: 10 }}>
                              {t("taskPanel.running")}
                            </span>
                          )}
                        </span>
                        <span
                          className="truncate font-mono"
                          style={{ color: "var(--kf-text-muted)", fontSize: 10 }}
                          title={task.command}
                        >
                          {task.detail ?? task.command}
                        </span>
                      </span>
                    </button>

                    {/* 動かしっぱなしのタスクは再起動も出す（停止は行の主操作） */}
                    {active && (
                      <button
                        className="shrink-0 opacity-70 hover:opacity-100"
                        title={t("taskPanel.restart")}
                        aria-label={t("taskPanel.restart")}
                        onClick={() => restartTask(manifest, task, active.terminalId)}
                      >
                        <Icon name="restart_alt" size={14} />
                      </button>
                    )}

                    {/* ホバーで出るメニュー。右クリックでも同じものを開く */}
                    <button
                      className="shrink-0 opacity-0 group-hover:opacity-70 hover:!opacity-100 transition-opacity"
                      title={t("taskPanel.moreActions")}
                      aria-label={t("taskPanel.moreActions")}
                      aria-haspopup="menu"
                      onClick={(e) => {
                        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                        setMenu({ x: rect.left, y: rect.bottom, manifest, task });
                      }}
                    >
                      <Icon name="more_vert" size={14} />
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {/* シェル領域 */}
        {HAS_TERMINAL ? (
          <>
            <div
              className="shrink-0 h-1 cursor-row-resize hover:bg-blue-500 hover:opacity-60"
              style={{ backgroundColor: "var(--kf-border)", touchAction: "none" }}
              onMouseDown={startShellDrag}
            />
            <div
              className="shrink-0 flex flex-col overflow-hidden"
              style={{ height: `${shellRatio}%` }}
            >
              <div
                className="flex items-center gap-1.5 px-2 py-1 shrink-0"
                style={{
                  backgroundColor: "var(--kf-bg-secondary)",
                  color: "var(--kf-text-secondary)",
                }}
              >
                <Icon name="terminal" size={12} style={{ flexShrink: 0 }} />
                <span className="truncate font-mono" title={shell?.cwd}>
                  {shell ? baseName(shell.cwd) : t("taskPanel.shellIdle")}
                </span>
                {/* シェルのフォルダと一覧のフォルダがずれていることを隠さない。
                    この状態で実行すると、いまのフォルダのシェルを開き直す。 */}
                {shell && data && !samePath(shell.cwd, data.dir) && (
                  <span
                    className="shrink-0 px-1 rounded"
                    style={{
                      backgroundColor: "var(--kf-bg-tertiary)",
                      color: "var(--kf-text-muted)",
                    }}
                    title={t("taskPanel.shellOtherFolderHint", { dir: shell.cwd })}
                  >
                    {t("taskPanel.shellOtherFolder")}
                  </span>
                )}
                <span className="flex-1" />
                {running.length > 0 && (
                  <span className="truncate" style={{ color: "var(--kf-info)" }}>
                    {running.map((r) => r.label).join(", ")}
                  </span>
                )}
              </div>
              <div className="flex-1 min-h-0">
                {shellTab && (
                  <Suspense fallback={null}>
                    <Terminal key={shellTab.terminalId} tab={shellTab} isActive={!hidden} />
                  </Suspense>
                )}
              </div>
            </div>
          </>
        ) : (
          manifests.length > 0 && (
            <div
              className="px-3 py-2 border-t shrink-0"
              style={{ borderColor: "var(--kf-border)", color: "var(--kf-text-muted)" }}
            >
              {t("taskPanel.terminalUnavailable")}
            </div>
          )
        )}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}
