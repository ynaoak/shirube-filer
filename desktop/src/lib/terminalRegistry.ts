/**
 * ターミナル（xterm + PTY）の実体を React の外に置く置き場。
 *
 * ペインを閉じるとレイアウトの木の形が変わる（分割が 1 つになればその分割は消え、
 * 残ったペインは木の別の位置へ移る）。React から見ると位置が変わったペインは
 * 作り直し（unmount → mount）になるため、実体をコンポーネントに抱えさせると、
 * **閉じたのとは別のペイン**のシェルまで作り直されてしまう。動かしていた
 * プロセス（claude や開発サーバー）はそこで死ぬ。
 *
 * そこで実体はここに預け、コンポーネントは「借りて表示先に差し込む」だけにする。
 * 作り直しのときは表示先から外すだけなので、プロセスと画面の内容は保たれる。
 * 実体を捨てるのはタブが本当に閉じられたとき（disposeTerminal）。
 */

export type TerminalHandle = {
  /** 表示先の要素へ差し込む */
  attach: (host: HTMLElement) => void;
  /** 表示先から外す（実体は保つ） */
  detach: () => void;
  /** 表示サイズに合わせ直す */
  resize: () => void;
  focus: () => void;
  /** 実体を捨てる（PTY も落とす） */
  dispose: () => void;
};

const handles = new Map<string, TerminalHandle>();

/**
 * 実体を借りる。置き場に無ければ `create` で作って預ける。
 *
 * 同じ terminalId で二重に作らないことが肝心（作ると PTY が置き換わって、
 * それまで動かしていたプロセスが死ぬ）。
 */
export function acquireTerminal(id: string, create: () => TerminalHandle): TerminalHandle {
  const existing = handles.get(id);
  if (existing) return existing;
  const created = create();
  handles.set(id, created);
  return created;
}

/** 表示先から外す（実体は置き場に残す）。 */
export function releaseTerminal(id: string) {
  handles.get(id)?.detach();
}

/** 実体を捨てる。タブが閉じられた・作り直したいときだけ呼ぶ。 */
export function disposeTerminal(id: string) {
  const handle = handles.get(id);
  if (!handle) return;
  handles.delete(id);
  handle.dispose();
}

/** 置き場にある実体をすべて捨てる。 */
export function disposeAllTerminals() {
  for (const id of Array.from(handles.keys())) disposeTerminal(id);
}

/** いま置き場にある terminalId。 */
export function registeredTerminalIds(): string[] {
  return Array.from(handles.keys());
}

/**
 * 「前はあったのに今は無い」ターミナルだけを捨てる。
 *
 * レイアウトから消えたタブの後始末に使う。`known` に入っていない id
 * （タスクパネルのシェルなど、レイアウトに属さないもの）には手を出さない。
 *
 * @param known これまでレイアウトにあった id
 * @param alive いまレイアウトにある id
 * @returns 捨てた id
 */
export function disposeRemovedTerminals(
  known: Iterable<string>,
  alive: ReadonlySet<string>
): string[] {
  const removed: string[] = [];
  for (const id of known) {
    if (alive.has(id)) continue;
    removed.push(id);
    disposeTerminal(id);
  }
  return removed;
}
