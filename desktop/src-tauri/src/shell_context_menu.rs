/// Show the OS native shell context menu for one or more files.
/// On non-Windows platforms this is a no-op (returns Ok immediately).
#[tauri::command]
pub fn show_shell_context_menu(
    window: tauri::WebviewWindow,
    paths: Vec<String>,
    screen_x: i32,
    screen_y: i32,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        let hwnd_raw = {
            let handle = window.window_handle().map_err(|e| e.to_string())?;
            match handle.as_raw() {
                RawWindowHandle::Win32(h) => h.hwnd.get(),
                _ => return Err("Not a Win32 window".to_string()),
            }
        };
        window
            .run_on_main_thread(move || {
                let _ = show_context_menu_win(hwnd_raw, &paths, screen_x, screen_y);
            })
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    {
        let _ = (window, paths, screen_x, screen_y);
        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn show_context_menu_win(
    hwnd_raw: isize,
    paths: &[String],
    screen_x: i32,
    screen_y: i32,
) -> Result<(), String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows::core::{PCSTR, PCWSTR};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{
        CoInitializeEx, CoTaskMemFree, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{
        IContextMenu, IShellFolder, IShellItem, SHBindToParent,
        SHCreateItemFromParsingName, SHGetIDListFromObject, CMINVOKECOMMANDINFO,
    };
    use windows::Win32::UI::Shell::Common::ITEMIDLIST;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreatePopupMenu, DestroyMenu, TrackPopupMenu, TPM_LEFTALIGN, TPM_RETURNCMD,
        TPM_TOPALIGN,
    };

    if paths.is_empty() {
        return Ok(());
    }

    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        let hwnd = HWND(hwnd_raw as *mut _);

        let path = &paths[0];
        let wide: Vec<u16> = OsStr::new(path.as_str())
            .encode_wide()
            .chain(Some(0))
            .collect();

        // IShellItem from path
        let item: IShellItem =
            SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None)
                .map_err(|e| e.to_string())?;

        // PIDL from IShellItem
        let pidl: *mut ITEMIDLIST =
            SHGetIDListFromObject(&item).map_err(|e| e.to_string())?;

        // Parent IShellFolder + child PIDL
        // SHBindToParent's ppidllast is *mut *mut ITEMIDLIST
        let mut child_pidl: *mut ITEMIDLIST = std::ptr::null_mut();
        let parent: IShellFolder =
            SHBindToParent(pidl as *const ITEMIDLIST, Some(&mut child_pidl))
                .map_err(|e| e.to_string())?;

        // GetUIObjectOf takes &[*const ITEMIDLIST] (no cidl parameter; length from slice)
        let child_pidl_const = child_pidl as *const ITEMIDLIST;
        let ctx: IContextMenu = parent
            .GetUIObjectOf(hwnd, &[child_pidl_const], None)
            .map_err(|e| e.to_string())?;

        let hmenu = CreatePopupMenu().map_err(|e| e.to_string())?;

        // QueryContextMenu returns HRESULT (not Result), call it and check manually
        let hr = ctx.QueryContextMenu(hmenu, 0, 1, 0x7FFF, 0);
        if hr.is_err() {
            let _ = DestroyMenu(hmenu);
            CoTaskMemFree(Some(pidl.cast()));
            return Err(hr.to_string());
        }

        // Show the menu; nreserved is Option<i32> in windows 0.61
        let cmd = TrackPopupMenu(
            hmenu,
            TPM_RETURNCMD | TPM_LEFTALIGN | TPM_TOPALIGN,
            screen_x,
            screen_y,
            Some(0),
            hwnd,
            None,
        );

        if cmd.0 > 0 {
            let offset = (cmd.0 as u32).wrapping_sub(1); // offset from idCmdFirst (1)
            let ci = CMINVOKECOMMANDINFO {
                cbSize: std::mem::size_of::<CMINVOKECOMMANDINFO>() as u32,
                hwnd,
                lpVerb: PCSTR(offset as usize as *const u8),
                nShow: 1, // SW_SHOWNORMAL
                ..Default::default()
            };
            let _ = ctx.InvokeCommand(&ci);
        }

        let _ = DestroyMenu(hmenu);
        CoTaskMemFree(Some(pidl.cast()));

        Ok(())
    }
}
