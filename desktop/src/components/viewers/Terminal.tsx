import { useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { isInternalDrag, readInternalDrag } from "../../lib/nativeFileDrag";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { TerminalTab } from "../../types/layout";
import { APP_EVENTS } from "../../lib/appEvents";
import { dropTerminalCommand, takeTerminalCommand } from "../../lib/terminalCommand";
import {
  acquireTerminal,
  releaseTerminal,
  type TerminalHandle,
} from "../../lib/terminalRegistry";
import { useUiSettings } from "../../store/uiSettingsStore";

type PtyOutput = {
  terminalId: string;
  data: string;
};

type PtyCwd = {
  terminalId: string;
  cwd: string;
};

type Props = {
  tab: TerminalTab;
  isActive: boolean;
};

/** PTY 起動から、預かったコマンドを流し込むまでの待ち時間 */
const STARTUP_COMMAND_DELAY_MS = 400;

const XTERM_THEME = {
  background: "#171717",
  foreground: "#e5e5e5",
  cursor: "#e5e5e5",
  black: "#171717",
  brightBlack: "#525252",
  red: "#ef4444",
  brightRed: "#f87171",
  green: "#22c55e",
  brightGreen: "#4ade80",
  yellow: "#eab308",
  brightYellow: "#facc15",
  blue: "#3b82f6",
  brightBlue: "#60a5fa",
  magenta: "#a855f7",
  brightMagenta: "#c084fc",
  cyan: "#06b6d4",
  brightCyan: "#22d3ee",
  white: "#e5e5e5",
  brightWhite: "#ffffff",
};

/**
 * xterm と PTY の実体を組み立てる。
 *
 * React のマウントとは切り離して terminalRegistry に預けるため、コンポーネントの
 * ライフサイクルに依存しない形で作る。表示先の差し替え（ペインの組み替え）では
 * 要素を付け外しするだけで、PTY も画面の内容もそのまま引き継がれる。
 */
function createTerminalHandle(options: {
  terminalId: string;
  cwd: string;
  shell: string;
  /** 最初の表示先。xterm は文字サイズを実測するので、open 前に DOM へ入れる */
  host: HTMLElement;
  failedStartMessage: (error: unknown) => string;
}): TerminalHandle {
  const { terminalId, cwd, shell, host, failedStartMessage } = options;

  // xterm が描画する入れ物。これごと親を移し替えれば中身（スクロールバック）は残る
  const element = document.createElement("div");
  element.style.width = "100%";
  element.style.height = "100%";
  host.appendChild(element);

  const xterm = new XTerm({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
    theme: XTERM_THEME,
  });
  const fitAddon = new FitAddon();
  xterm.loadAddon(fitAddon);
  xterm.loadAddon(new WebLinksAddon());
  // DOM に入れてから開く（切り離された要素で開くと文字サイズが測れない）
  xterm.open(element);

  let disposed = false;
  let startupCommandTimer: ReturnType<typeof setTimeout> | null = null;
  const unlistens: UnlistenFn[] = [];

  const setup = async () => {
    // PTY 出力を受信。表示先から外れている間も受け続けるので、戻したときに
    // その間の出力がそのまま画面に残っている。
    const unlistenOutput = await listen<PtyOutput>("pty-output", (event) => {
      if (event.payload.terminalId === terminalId) {
        xterm.write(event.payload.data);
      }
    });
    if (disposed) {
      unlistenOutput();
      return;
    }
    unlistens.push(unlistenOutput);

    // OSC 7 cwd 変更を受信 → kf-terminal-cwd CustomEvent として中継
    const unlistenCwd = await listen<PtyCwd>("pty-cwd", (event) => {
      if (event.payload.terminalId === terminalId) {
        window.dispatchEvent(
          new CustomEvent(APP_EVENTS.TERMINAL_CWD, {
            detail: { terminalId, cwd: event.payload.cwd },
          })
        );
      }
    });
    if (disposed) {
      unlistenCwd();
      return;
    }
    unlistens.push(unlistenCwd);

    // ユーザー入力を PTY に送信
    xterm.onData((data) => {
      invoke("pty_write", { terminalId, data }).catch(console.error);
    });

    let started = true;
    try {
      await invoke("pty_create", { terminalId, cwd, shell: shell || null });
    } catch (e) {
      started = false;
      if (!disposed) {
        xterm.write(`\r\n\x1b[31m${failedStartMessage(e)}\x1b[0m\r\n`);
      }
    }

    // 起動の途中で捨てられていた場合は、作ってしまった PTY を自分で落とす
    if (disposed) {
      invoke("pty_kill", { terminalId }).catch(console.error);
      return;
    }
    if (!started) {
      dropTerminalCommand(terminalId);
      return;
    }

    // タスクパネルから開かれたターミナルは、起動直後に預かったコマンドを流す。
    // シェルが端末の入力を読み始める前に書くと初期化処理に流されることがあるため、
    // 一拍おいてから送る。
    const queued = takeTerminalCommand(terminalId);
    if (queued) {
      startupCommandTimer = setTimeout(() => {
        startupCommandTimer = null;
        // submit が false のときは Enter を送らず、入力欄に置くだけにする
        const data = queued.submit ? `${queued.command}\r` : queued.command;
        invoke("pty_write", { terminalId, data }).catch(console.error);
      }, STARTUP_COMMAND_DELAY_MS);
    }
  };

  setup();

  return {
    attach: (nextHost: HTMLElement) => {
      // 同じ表示先なら触らない（付け替えると描画が一度消える）
      if (element.parentElement !== nextHost) nextHost.appendChild(element);
    },
    detach: () => {
      element.remove();
    },
    resize: () => {
      // 表示されていない（幅・高さが 0）ときは測れないので触らない。
      // タスクパネルを閉じている間や、タブが非表示のときがこれに当たる。
      if (!element.isConnected || element.clientWidth === 0 || element.clientHeight === 0) {
        return;
      }
      fitAddon.fit();
      invoke("pty_resize", { terminalId, rows: xterm.rows, cols: xterm.cols }).catch(
        console.error
      );
    },
    focus: () => {
      if (element.isConnected) xterm.focus();
    },
    dispose: () => {
      disposed = true;
      if (startupCommandTimer !== null) clearTimeout(startupCommandTimer);
      unlistens.forEach((fn) => fn());
      unlistens.length = 0;
      dropTerminalCommand(terminalId);
      element.remove();
      xterm.dispose();
      invoke("pty_kill", { terminalId }).catch(console.error);
    },
  };
}

export default function Terminal({ tab, isActive }: Props) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<TerminalHandle | null>(null);
  const [uiSettings] = useUiSettings();
  // cwd / terminalShell は実体を作るときの初期値にのみ使う。
  // OSC 7 で tab.cwd が更新されたり設定が変わっても PTY は作り直さない。
  const initialCwdRef = useRef(tab.cwd);
  const initialShellRef = useRef(uiSettings.terminalShell);
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const handle = acquireTerminal(tab.terminalId, () =>
      createTerminalHandle({
        terminalId: tab.terminalId,
        cwd: initialCwdRef.current,
        shell: initialShellRef.current,
        host,
        failedStartMessage: (error) => tRef.current("terminal.failedStart", { error }),
      })
    );
    handleRef.current = handle;
    handle.attach(host);

    // react-resizable-panels がパネルサイズを確定するのを待ってから測る。
    // useEffect は paint 後に走るが、パネルライブラリが CSS を同一フレーム内で
    // 適用しきれていない場合があるため rAF で 1 フレーム遅延する。
    const fitRafId = requestAnimationFrame(() => {
      handle.resize();
      handle.focus();
    });

    return () => {
      cancelAnimationFrame(fitRafId);
      // ペインを閉じてレイアウトが組み替わると、閉じたのとは別のペインでも
      // React は作り直しになる。ここで実体を捨てるとシェルのプロセスまで
      // 死ぬので、表示先から外すだけにする。片付けはタブが閉じられたときに
      // LayoutRoot（レイアウト外のシェルは持ち主）が disposeTerminal で行う。
      releaseTerminal(tab.terminalId);
      handleRef.current = null;
    };
  }, [tab.terminalId]);

  // #46: ファイルをターミナルにドロップしてパスを貼り付け
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (isInternalDrag(e.dataTransfer)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      // 他アプリへ引き出せるよう OS のドラッグに切り替わっている間は
      // dataTransfer が空になるため、控えたほうを読む。
      const payload = readInternalDrag(e.dataTransfer);
      if (!payload) return;
      const quoted = payload.srcPath.includes(" ") ? `"${payload.srcPath}"` : payload.srcPath;
      invoke("pty_write", { terminalId: tab.terminalId, data: quoted }).catch(console.error);
    },
    [tab.terminalId]
  );

  // リサイズ対応
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const handleResize = () => handleRef.current?.resize();
    const observer = new ResizeObserver(handleResize);
    observer.observe(host);
    // ResizeObserver は現在サイズでは発火しないため、セットアップ直後に 1 回実行する。
    // これにより rAF より遅れて確定したパネルサイズにも対応できる。
    handleResize();
    return () => observer.disconnect();
  }, [tab.terminalId]);

  // タブ切り替えでアクティブになった際に fit + focus を再実行する。
  // display:none → 表示への切り替え時は ResizeObserver が発火しないため手動で実行する。
  useEffect(() => {
    if (!isActive) return;
    const raf = requestAnimationFrame(() => {
      handleRef.current?.resize();
      handleRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [isActive, tab.terminalId]);

  return (
    <div
      ref={hostRef}
      className="w-full h-full bg-neutral-950 p-1 overflow-hidden"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onMouseDown={(e) => {
        // preventDefault でブラウザのデフォルトフォーカス動作（tabIndex=-1 の祖先 div への
        // フォーカス移動）を防ぎ、xterm の textarea に確実にフォーカスを与える。
        // xterm 自身の mousedown ハンドラ（テキスト選択等）はネイティブリスナーとして
        // バブリング前に実行済みのため影響しない。
        e.preventDefault();
        handleRef.current?.focus();
      }}
      onClick={() => handleRef.current?.focus()}
    />
  );
}
