use std::collections::HashMap;
use std::path::Path;
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// 変更が止まってから通知するまでの待ち時間。
const DEBOUNCE: Duration = Duration::from_millis(400);
/// 変更が続いている間でも、この間隔では必ず 1 回通知する
/// （長時間のコピー中に一覧がまったく更新されないのを防ぐ）。
const MAX_COALESCE: Duration = Duration::from_millis(1500);

#[derive(Serialize, Clone)]
pub struct FsChangedPayload {
    pub path: String,
}

/// Each watched path stores the watcher + a reference count.
/// When multiple panes watch the same directory, the watcher is shared.
/// It is removed only when the last reference is released.
pub struct WatchState(pub Mutex<HashMap<String, (RecommendedWatcher, u32)>>);

impl Default for WatchState {
    fn default() -> Self {
        WatchState(Mutex::new(HashMap::new()))
    }
}

#[tauri::command]
pub fn watch_dir(
    app: AppHandle,
    state: State<'_, WatchState>,
    path: String,
) -> Result<(), String> {
    let mut watchers = state.0.lock().map_err(|e| e.to_string())?;

    // Already watching this path — just increment the reference count
    if let Some((_, count)) = watchers.get_mut(&path) {
        *count += 1;
        return Ok(());
    }

    // notify のイベントをそのまま emit すると、コピー・削除など 1 操作で
    // 大量のイベントが発生したときにフロントが read_dir と再描画を繰り返して
    // 固まってしまう。専用スレッドでバーストをまとめ、静穏になったとき
    // （または MAX_COALESCE ごと）に 1 回だけ通知する。
    let (tx, rx) = channel::<()>();
    let emit_path = path.clone();
    thread::spawn(move || {
        while rx.recv().is_ok() {
            let burst_start = Instant::now();
            loop {
                match rx.recv_timeout(DEBOUNCE) {
                    // まだ変更が続いている。ただし溜め込みすぎないよう上限で打ち切る
                    Ok(()) => {
                        if burst_start.elapsed() >= MAX_COALESCE {
                            break;
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => break,
                    // watcher が破棄された（unwatch_dir）ためスレッドを終了する
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            let _ = app.emit("fs:changed", FsChangedPayload { path: emit_path.clone() });
        }
    });

    let mut w = RecommendedWatcher::new(
        move |res: notify::Result<notify::Event>| {
            if res.is_ok() {
                // 送信先スレッドが終了していても無視する
                let _ = tx.send(());
            }
        },
        notify::Config::default().with_poll_interval(Duration::from_millis(500)),
    )
    .map_err(|e| e.to_string())?;

    w.watch(Path::new(&path), RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    watchers.insert(path, (w, 1));
    Ok(())
}

#[tauri::command]
pub fn unwatch_dir(state: State<'_, WatchState>, path: String) -> Result<(), String> {
    let mut watchers = state.0.lock().map_err(|e| e.to_string())?;

    if let Some((_, count)) = watchers.get_mut(&path) {
        if *count > 1 {
            *count -= 1;
            return Ok(());
        }
    }

    // Last reference — remove the watcher entirely
    watchers.remove(&path);
    Ok(())
}
