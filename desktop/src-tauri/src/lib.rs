mod config;
mod addon_commands;
mod clipboard_commands;
mod sync_history_commands;
mod context_menu_commands;
mod progress;
mod archive_commands;
mod favorites_commands;
mod file_ops;
mod fs_commands;
mod git_commands;
mod keybinding_commands;
mod layout_commands;
mod oauth_state;
mod preview_commands;
#[cfg(not(feature = "msstore"))]
mod process_commands;
mod box_commands;
mod dropbox_commands;
mod gcs_commands;
mod gdrive_commands;
mod onedrive_commands;
mod s3_commands;
mod azblob_commands;
mod sftp_commands;
mod trash_commands;
mod watch_commands;
mod index_commands;
mod tag_commands;
mod color_label_commands;
mod rule_commands;
mod sync_commands;
mod secret_commands;
mod exif_commands;
mod webdav_commands;
mod settings_commands;
mod http_client;
mod update_commands;
mod shell_context_menu;
mod icon_commands;
mod mtp_commands;
mod task_commands;
mod window_commands;

// ゴミ箱移動は Windows だけ IFileOperation を直接使う（trash クレートでは
// 失敗理由が分からず、フォルダ削除が原因不明のエラーになるため）
#[cfg(windows)]
mod windows_trash;

// PTY is not available in the MAS sandbox build or Microsoft Store build
#[cfg(not(any(feature = "mas", feature = "msstore")))]
mod pty_commands;

// 組み込みサーバーはストア版では持たない。MAS の App Sandbox には
// com.apple.security.network.server が無く、待ち受けができない。
#[cfg(not(any(feature = "mas", feature = "msstore")))]
mod static_server;

// Security-Scoped Bookmarks are only needed for MAS sandbox build on macOS
#[cfg(all(target_os = "macos", feature = "mas"))]
mod bookmark_commands;

use addon_commands::{get_addon_entry_path, install_addon, list_addons, set_addon_enabled, uninstall_addon};
use context_menu_commands::{load_context_menu_config, save_context_menu_config};
// run_user_command is disabled in Store builds (user-defined shell commands, Store policy)
#[cfg(not(feature = "msstore"))]
use context_menu_commands::run_user_command;
use progress::{cancel_operation, CancelState};
use archive_commands::{compress, decompress, list_archive};
use favorites_commands::{load_bookmarks, save_bookmarks};
use file_ops::{copy_item, create_dir, create_file, create_file_from_template, create_symlink, delete_item, empty_trash, list_templates, move_item, path_exists, paths_exist, rename_item, unique_dest_path};
use fs_commands::{cancel_scan, get_file_metadata, get_home_dir, get_parent_dir, read_dir, search_files, grep_files, get_dir_size, get_disk_usage, compare_dirs, find_duplicates, set_file_readonly, set_file_hidden, get_checksum, list_volumes, open_with_app, spawn_volume_watcher, ScanState};
use git_commands::{git_blame, git_checkout_branch, git_commit, git_diff, git_find_root, git_log, git_repo_status, git_show, git_stage, git_stash_apply, git_stash_drop, git_stash_list, git_stash_pop, git_stash_save, git_unstage};
use keybinding_commands::{load_keybindings, reset_keybindings, save_keybindings};
use layout_commands::{export_layout, import_layout, load_layout, save_layout};
use clipboard_commands::{clipboard_get_file_list, clipboard_set_file_list, clipboard_clear_file_list};
use sync_history_commands::{append_sync_history, load_sync_history, clear_sync_history};
use oauth_state::{OAuthDispatcher, cancel_oauth_flow, deliver_oauth_code};
use preview_commands::{read_text_file, read_text_file_sniffed, read_file_bytes, read_file_as_data_url, write_text_file};
// run_external_command is disabled in Store builds (arbitrary shell execution)
#[cfg(not(feature = "msstore"))]
use process_commands::run_external_command;
use task_commands::detect_project_tasks;
use tauri::{Emitter, Manager};
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use box_commands::{box_start_oauth_flow, box_refresh_access_token, box_list_folder, box_download_file, box_upload_file, box_delete_item, box_create_folder};
use dropbox_commands::{dropbox_start_oauth_flow, dropbox_refresh_access_token, dropbox_list_folder, dropbox_download_file, dropbox_upload_file, dropbox_delete_item, dropbox_create_folder};
use gcs_commands::{gcs_start_oauth_flow, gcs_refresh_access_token, gcs_list_buckets, gcs_list_objects, gcs_download_object, gcs_upload_object, gcs_delete_object};
use gdrive_commands::{gdrive_start_oauth_flow, gdrive_refresh_access_token, gdrive_list_files, gdrive_download_file, gdrive_upload_file, gdrive_delete_file, gdrive_create_folder};
use onedrive_commands::{onedrive_start_oauth_flow, onedrive_refresh_access_token, onedrive_list_files, onedrive_download_file, onedrive_upload_file, onedrive_delete_file, onedrive_create_folder};
use s3_commands::{s3_list_buckets, s3_list_objects, s3_download_object, s3_upload_object, s3_delete_object};
use azblob_commands::{azblob_list_objects, azblob_download_object, azblob_upload_object, azblob_delete_object};
use update_commands::check_for_update;
use sftp_commands::{sftp_list_dir, sftp_download, sftp_upload, sftp_mkdirs, sftp_delete};
use trash_commands::{list_trash_items, restore_trash_item, purge_trash_item};
use watch_commands::{watch_dir, unwatch_dir, WatchState};
use index_commands::{build_index, search_index, index_status, clear_index, IndexState};
use tag_commands::{load_tags, save_tags};
use color_label_commands::{load_color_labels, save_color_labels};
use rule_commands::{load_rules, save_rules};
use sync_commands::{load_sync_jobs, save_sync_jobs};
use secret_commands::{secret_set, secret_get, secret_delete};
use exif_commands::get_exif_data;
use webdav_commands::{webdav_list_dir, webdav_download, webdav_upload, webdav_delete, webdav_mkdir};
use settings_commands::{load_ui_settings, save_ui_settings, get_ui_settings_path, list_shells, clear_app_data};
use shell_context_menu::show_shell_context_menu;
use icon_commands::{get_embedded_icon, get_file_type_icon};
use mtp_commands::{mtp_list_devices, mtp_download};
use window_commands::{set_title_bar_color, get_os_accent_color, get_platform, window_at_cursor, stash_tearoff, take_tearoff, TearoffStash};

#[cfg(not(any(feature = "mas", feature = "msstore")))]
use pty_commands::{pty_create, pty_kill, pty_resize, pty_write};

#[cfg(not(any(feature = "mas", feature = "msstore")))]
use static_server::{
    list_static_servers, load_server_presets, save_server_presets, start_static_server,
    stop_static_server,
};

#[cfg(all(target_os = "macos", feature = "mas"))]
use bookmark_commands::{resolve_bookmark, save_bookmark, stop_bookmark_access};

/// フィードバック（スクリーンショット + テキスト）を Downloads/shirube-filer-feedback/ に保存
#[tauri::command]
async fn save_feedback(
    app: tauri::AppHandle,
    description: String,
    category: String,
    screenshot_data: String, // base64 data URL
) -> Result<String, String> {
    use base64::engine::Engine as _;
    let download_dir = app
        .path()
        .download_dir()
        .map_err(|e| e.to_string())?;
    let feedback_dir = download_dir.join("shirube-filer-feedback");
    std::fs::create_dir_all(&feedback_dir).map_err(|e| e.to_string())?;

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let base = format!("feedback_{ts}");

    // PNG 保存
    let png_name = format!("{base}.png");
    if !screenshot_data.is_empty() {
        let b64 = screenshot_data
            .trim_start_matches("data:image/png;base64,")
            .trim_start_matches("data:image/jpeg;base64,");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| e.to_string())?;
        std::fs::write(feedback_dir.join(&png_name), decoded)
            .map_err(|e| e.to_string())?;
    }

    // JSON メタデータ保存
    let meta = serde_json::json!({
        "timestamp": ts,
        "category": category,
        "description": description,
        "screenshot": png_name,
    });
    std::fs::write(
        feedback_dir.join(format!("{base}.json")),
        serde_json::to_string_pretty(&meta).unwrap(),
    )
    .map_err(|e| e.to_string())?;

    Ok(feedback_dir.to_string_lossy().into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 2重起動を防ぎ、既存ウィンドウを前面に出す。deep-link URL（shirube-filer://...）は
        // Windows/Linux では新プロセスの引数として渡されるため、single-instance の
        // deep-link 連携で実行中インスタンスの on_open_url へ転送する（OAuth 完了に必須）。
        // ※ 最初のプラグインとして登録すること。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        // 一覧から他アプリ（エクスプローラー等）へファイルを引き出すための
        // OS ネイティブのドラッグ。WebView の HTML5 ドラッグはページ内で完結し、
        // OS に「これはファイルだ」と伝える手段が無いため、この経路が要る。
        .plugin(tauri_plugin_drag::init())
        // ウィンドウのサイズ・位置・最大化状態をラベル別に保存し、次回起動時に復元する。
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // アップデート適用後の再起動（relaunch）用。
        .plugin(tauri_plugin_process::init())
        .manage(CancelState::default())
        .manage(ScanState::default())
        .manage(WatchState::default())
        .manage(IndexState::default())
        .manage(OAuthDispatcher::default())
        .manage(TearoffStash::default())
        .setup(|app| {
            use tauri_plugin_deep_link::DeepLinkExt;
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                let dispatcher = handle.state::<OAuthDispatcher>();
                for url in event.urls() {
                    deliver_oauth_code(&dispatcher, url.as_str());
                }
            });

            // 開発ビルドやポータブル実行でも deep-link を受け取れるよう、
            // 実行時に OS へ URL スキームを登録する（Windows: レジストリ / Linux: .desktop）。
            // インストーラ経由では既に登録済みのため失敗しても無視してよい。
            #[cfg(any(windows, target_os = "linux"))]
            {
                let _ = app.deep_link().register_all();
            }

            // 自動アップデート（Direct 配布版のみ）。ストア版はストアが更新を配信するため
            // プラグイン自体を登録しない（webview から updater を呼べなくする）。
            #[cfg(all(desktop, not(any(feature = "mas", feature = "msstore"))))]
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;

            // USB / スマートフォン等の抜き差しを OS ネイティブのイベントで監視し、
            // ドライブ一覧を自動更新する（macOS/Linux はここでスレッド起動）。
            spawn_volume_watcher(app.handle().clone());
            // Windows はメインウィンドウの WM_DEVICECHANGE を購読する（UI スレッドで登録）。
            #[cfg(windows)]
            {
                if let Some(win) = app.get_webview_window("main") {
                    fs_commands::register_device_notifications(&win, app.handle().clone());
                }
            }

            // ── ネイティブメニュー ──────────────────────────────────────────
            let h = app.handle();

            // ドライブ一覧サブメニュー
            let volumes = list_volumes();
            let mut drive_submenu_builder = SubmenuBuilder::new(h, "ドライブ");
            for vol in &volumes {
                let label = if !vol.label.is_empty() && vol.label != vol.path {
                    format!("{} ({})", vol.label, vol.path)
                } else {
                    vol.path.clone()
                };
                let id = format!("open-drive:{}", vol.path);
                let item = MenuItemBuilder::with_id(&id, &label).build(h)?;
                drive_submenu_builder = drive_submenu_builder.item(&item);
            }
            let drive_submenu = drive_submenu_builder.build()?;

            // ファイル
            // NOTE: CmdOrCtrl+T と CmdOrCtrl+W はネイティブアクセラレータを設定しない。
            // アクセラレータを設定するとOSがキーを先取りし、ターミナル内でCtrl+W(単語削除)や
            // Ctrl+T(文字入れ替え)が使えなくなる。代わりにJS側のキーハンドラで処理する。
            let new_tab = MenuItemBuilder::with_id("new-tab", "新しいタブ").build(h)?;
            let close_tab = MenuItemBuilder::with_id("close-tab", "タブを閉じる").build(h)?;
            let open_trash = MenuItemBuilder::with_id("open-trash", "ゴミ箱を開く").build(h)?;
            let file_menu_base = SubmenuBuilder::new(h, "ファイル")
                .item(&new_tab).item(&close_tab).separator()
                .item(&open_trash).item(&drive_submenu);
            // 終了は macOS だとアプリメニュー側が正位置なので「ファイル」には置かない。
            #[cfg(not(target_os = "macos"))]
            let file_menu_base = {
                let quit = PredefinedMenuItem::quit(h, Some("終了"))?;
                file_menu_base.separator().item(&quit)
            };
            let file_menu = file_menu_base.build()?;

            // 表示
            let toggle_file_tree   = MenuItemBuilder::with_id("toggle-file-tree",   "ファイルツリー").build(h)?;
            let toggle_bookmark    = MenuItemBuilder::with_id("toggle-bookmark",    "ブックマーク").build(h)?;
            let toggle_preview     = MenuItemBuilder::with_id("toggle-preview",     "プレビュー").build(h)?;
            let toggle_git         = MenuItemBuilder::with_id("toggle-git",         "Git パネル").build(h)?;
            let toggle_grep        = MenuItemBuilder::with_id("toggle-grep",        "ファイル内容検索").build(h)?;
            let toggle_tasks       = MenuItemBuilder::with_id("toggle-tasks",       "プロジェクトタスク").build(h)?;
            let toggle_index       = MenuItemBuilder::with_id("toggle-index",       "高速検索（インデックス）").build(h)?;
            let toggle_tags        = MenuItemBuilder::with_id("toggle-tags",        "タグ").build(h)?;
            let toggle_rules       = MenuItemBuilder::with_id("toggle-rules",       "自動化ルール").build(h)?;
            let toggle_sync        = MenuItemBuilder::with_id("toggle-sync",        "クラウド同期").build(h)?;
            let toggle_queue       = MenuItemBuilder::with_id("toggle-queue",       "操作キュー").build(h)?;
            let toggle_compare     = MenuItemBuilder::with_id("toggle-compare",     "比較モード").build(h)?;
            let open_folder_compare = MenuItemBuilder::with_id("open-folder-compare", "フォルダ比較").build(h)?;
            let view_menu = SubmenuBuilder::new(h, "表示")
                .item(&toggle_file_tree).item(&toggle_bookmark).item(&toggle_preview)
                .item(&toggle_git).item(&toggle_tasks).item(&toggle_grep).item(&toggle_index).item(&toggle_tags).item(&toggle_rules).item(&toggle_sync).item(&toggle_queue)
                .separator()
                .item(&toggle_compare).item(&open_folder_compare)
                .build()?;

            // ツール
            let open_duplicates = MenuItemBuilder::with_id("open-duplicates", "重複ファイル検出").build(h)?;
            let command_palette = MenuItemBuilder::with_id("command-palette", "コマンドパレット")
                .accelerator("CmdOrCtrl+Shift+P").build(h)?;
            let open_addon_manager = MenuItemBuilder::with_id("open-addon-manager", "アドオン管理").build(h)?;
            let open_settings = MenuItemBuilder::with_id("open-settings", "設定")
                .accelerator("CmdOrCtrl+,").build(h)?;
            let open_feedback = MenuItemBuilder::with_id("open-feedback", "フィードバックを送る").build(h)?;
            let tools_menu_base = SubmenuBuilder::new(h, "ツール")
                .item(&open_duplicates).item(&command_palette)
                .separator().item(&open_addon_manager)
                .separator();
            // 設定（⌘,）も macOS ではアプリメニュー側に置くため、ここでは重複させない。
            #[cfg(not(target_os = "macos"))]
            let tools_menu_base = tools_menu_base.item(&open_settings);
            let tools_menu = tools_menu_base.item(&open_feedback).build()?;

            // macOS はアプリ全体で1つのメニューバー（ウィンドウに依らず上部に表示）が
            // 通常なので、これまで通りアプリメニューとして設定する。
            // Windows / Linux はメニューがウィンドウの装飾内に出るため、メインウィンドウ
            // （装飾なし＝バー非表示）にだけ適用し、設定など補助ウィンドウにメニューバーが
            // 出ないようにする。
            #[cfg(target_os = "macos")]
            {
                // macOS のメニューバーは「アプリメニュー → 編集 → …」が最低限の作法。
                //
                // とくに「編集」は必須で、Undo/Cut/Copy/Paste/Select All の
                // predefined item を置いて初めて WKWebView 内のテキスト入力で
                // ⌘C/⌘V/⌘X/⌘A/⌘Z が効くようになる（AppKit がこのメニューの
                // アクセラレータ経由で responder chain に流すため）。無いと
                // 名前の変更・検索欄・ターミナルでコピペが一切できない。
                //
                // 終了（⌘Q）・環境設定（⌘,）・隠す（⌘H）もアプリメニュー側が
                // 正位置。「ファイル」に入れていた終了はこちらへ移す。
                let app_menu = SubmenuBuilder::new(h, "Shirube-Filer")
                    .item(&PredefinedMenuItem::about(h, Some("Shirube-Filer について"), None)?)
                    .separator()
                    .item(&open_settings)
                    .separator()
                    .item(&PredefinedMenuItem::services(h, Some("サービス"))?)
                    .separator()
                    .item(&PredefinedMenuItem::hide(h, Some("Shirube-Filer を隠す"))?)
                    .item(&PredefinedMenuItem::hide_others(h, Some("ほかを隠す"))?)
                    .item(&PredefinedMenuItem::show_all(h, Some("すべてを表示"))?)
                    .separator()
                    .item(&PredefinedMenuItem::quit(h, Some("Shirube-Filer を終了"))?)
                    .build()?;

                let edit_menu = SubmenuBuilder::new(h, "編集")
                    .item(&PredefinedMenuItem::undo(h, Some("取り消す"))?)
                    .item(&PredefinedMenuItem::redo(h, Some("やり直す"))?)
                    .separator()
                    .item(&PredefinedMenuItem::cut(h, Some("カット"))?)
                    .item(&PredefinedMenuItem::copy(h, Some("コピー"))?)
                    .item(&PredefinedMenuItem::paste(h, Some("ペースト"))?)
                    .item(&PredefinedMenuItem::select_all(h, Some("すべてを選択"))?)
                    .build()?;

                // ウィンドウメニュー: 最小化/拡大/フルスクリーンは純正の
                // traffic light（titleBarStyle: "Overlay"）と対になる操作。
                let window_menu = SubmenuBuilder::new(h, "ウィンドウ")
                    .item(&PredefinedMenuItem::minimize(h, Some("しまう"))?)
                    .item(&PredefinedMenuItem::maximize(h, Some("拡大/縮小"))?)
                    .item(&PredefinedMenuItem::fullscreen(h, Some("フルスクリーン"))?)
                    .separator()
                    .item(&PredefinedMenuItem::close_window(h, Some("ウィンドウを閉じる"))?)
                    .build()?;

                let menu = MenuBuilder::new(h)
                    .item(&app_menu)
                    .item(&file_menu)
                    .item(&edit_menu)
                    .item(&view_menu)
                    .item(&tools_menu)
                    .item(&window_menu)
                    .build()?;
                app.set_menu(menu)?;
            }

            #[cfg(not(target_os = "macos"))]
            let menu = MenuBuilder::new(h)
                .item(&file_menu).item(&view_menu).item(&tools_menu)
                .build()?;

            // ウィンドウ状態の復元は plugin-window-state が on_window_ready で行うが、
            // 可視状態のまま生成すると「初期位置に出てから跳ぶ」ように見える。
            // main は tauri.conf.json で visible:false にしてあるため、ここで
            // 明示的に復元してから表示する（復元に失敗しても必ず表示する）。
            {
                use tauri_plugin_window_state::{StateFlags, WindowExt};
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.restore_state(StateFlags::all());
                    let _ = main.show();
                }
            }
            #[cfg(not(target_os = "macos"))]
            {
                if let Some(main_window) = app.get_webview_window("main") {
                    main_window.set_menu(menu)?;
                } else {
                    // フォールバック: メインウィンドウが取れない場合は従来通り全体に設定。
                    app.set_menu(menu)?;
                }
            }

            Ok(())
        })
        .on_menu_event(|app, event| {
            let _ = app.emit("menu-event", event.id().0.as_str());
        })
        .on_window_event(|window, event| {
            // 本体（main）を閉じたら、設定・キュー・フォルダ比較・クラウドブラウザ等の
            // ユーティリティウィンドウも一緒に閉じる。切り離しウィンドウ（main-*）は
            // 独立したファイラーとして残す。
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == "main" {
                    for (label, w) in window.app_handle().webview_windows() {
                        if label != "main" && !label.starts_with("main-") {
                            let _ = w.close();
                        }
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            read_dir,
            get_home_dir,
            get_parent_dir,
            get_file_metadata,
            search_files,
            grep_files,
            get_dir_size,
            get_disk_usage,
            cancel_scan,
            compare_dirs,
            find_duplicates,
            set_file_readonly,
            set_file_hidden,
            get_checksum,
            list_volumes,
            open_with_app,
            save_layout,
            load_layout,
            export_layout,
            import_layout,
            copy_item,
            move_item,
            delete_item,
            empty_trash,
            rename_item,
            create_dir,
            create_file,
            create_file_from_template,
            list_templates,
            create_symlink,
            path_exists,
            paths_exist,
            unique_dest_path,
            compress,
            decompress,
            list_archive,
            git_find_root,
            git_repo_status,
            git_stage,
            git_unstage,
            git_commit,
            git_checkout_branch,
            git_diff,
            git_log,
            git_show,
            git_stash_list,
            git_stash_apply,
            git_stash_drop,
            git_stash_pop,
            git_stash_save,
            git_blame,
            list_addons,
            set_addon_enabled,
            get_addon_entry_path,
            install_addon,
            uninstall_addon,
            load_bookmarks,
            save_bookmarks,
            save_keybindings,
            load_keybindings,
            reset_keybindings,
            read_text_file,
            read_text_file_sniffed,
            read_file_bytes,
            read_file_as_data_url,
            write_text_file,
            // arbitrary shell execution: disabled in Store builds
            #[cfg(not(feature = "msstore"))]
            run_external_command,
            // マニフェストを読むだけ（実行はターミナル側）なのでストア版でも有効
            detect_project_tasks,
            #[cfg(not(any(feature = "mas", feature = "msstore")))]
            start_static_server,
            #[cfg(not(any(feature = "mas", feature = "msstore")))]
            stop_static_server,
            #[cfg(not(any(feature = "mas", feature = "msstore")))]
            list_static_servers,
            #[cfg(not(any(feature = "mas", feature = "msstore")))]
            load_server_presets,
            #[cfg(not(any(feature = "mas", feature = "msstore")))]
            save_server_presets,
            sftp_list_dir,
            sftp_download,
            sftp_upload,
            sftp_mkdirs,
            sftp_delete,
            clipboard_get_file_list,
            clipboard_set_file_list,
            clipboard_clear_file_list,
            append_sync_history,
            load_sync_history,
            clear_sync_history,
            cancel_oauth_flow,
            box_start_oauth_flow,
            box_refresh_access_token,
            box_list_folder,
            box_download_file,
            box_upload_file,
            box_delete_item,
            box_create_folder,
            dropbox_start_oauth_flow,
            dropbox_refresh_access_token,
            dropbox_list_folder,
            dropbox_download_file,
            dropbox_upload_file,
            dropbox_delete_item,
            dropbox_create_folder,
            gcs_start_oauth_flow,
            gcs_refresh_access_token,
            gcs_list_buckets,
            gcs_list_objects,
            gcs_download_object,
            gcs_upload_object,
            gcs_delete_object,
            gdrive_start_oauth_flow,
            gdrive_refresh_access_token,
            gdrive_list_files,
            gdrive_download_file,
            gdrive_upload_file,
            gdrive_delete_file,
            gdrive_create_folder,
            onedrive_start_oauth_flow,
            onedrive_refresh_access_token,
            onedrive_list_files,
            onedrive_download_file,
            onedrive_upload_file,
            onedrive_delete_file,
            onedrive_create_folder,
            s3_list_buckets,
            s3_list_objects,
            s3_download_object,
            s3_upload_object,
            s3_delete_object,
            azblob_list_objects,
            azblob_download_object,
            azblob_upload_object,
            azblob_delete_object,
            check_for_update,
            list_trash_items,
            restore_trash_item,
            purge_trash_item,
            cancel_operation,
            load_context_menu_config,
            save_context_menu_config,
            // user-defined shell commands: disabled in Store builds
            #[cfg(not(feature = "msstore"))]
            run_user_command,
            watch_dir,
            unwatch_dir,
            build_index,
            search_index,
            index_status,
            clear_index,
            load_tags,
            save_tags,
            load_color_labels,
            save_color_labels,
            load_rules,
            save_rules,
            load_sync_jobs,
            save_sync_jobs,
            secret_set,
            secret_get,
            secret_delete,
            get_exif_data,
            webdav_list_dir,
            webdav_download,
            webdav_upload,
            webdav_delete,
            webdav_mkdir,
            load_ui_settings,
            save_ui_settings,
            get_ui_settings_path,
            list_shells,
            clear_app_data,
            show_shell_context_menu,
            get_embedded_icon,
            get_file_type_icon,
            mtp_list_devices,
            mtp_download,
            set_title_bar_color,
            get_os_accent_color,
            get_platform,
            window_at_cursor,
            stash_tearoff,
            take_tearoff,
            save_feedback,
            // PTY: disabled in MAS sandbox build and Microsoft Store build
            #[cfg(not(any(feature = "mas", feature = "msstore")))]
            pty_create,
            #[cfg(not(any(feature = "mas", feature = "msstore")))]
            pty_write,
            #[cfg(not(any(feature = "mas", feature = "msstore")))]
            pty_resize,
            #[cfg(not(any(feature = "mas", feature = "msstore")))]
            pty_kill,
            // Security-Scoped Bookmarks: MAS macOS build only
            #[cfg(all(target_os = "macos", feature = "mas"))]
            save_bookmark,
            #[cfg(all(target_os = "macos", feature = "mas"))]
            resolve_bookmark,
            #[cfg(all(target_os = "macos", feature = "mas"))]
            stop_bookmark_access,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
