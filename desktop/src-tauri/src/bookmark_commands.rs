/// Security-Scoped Bookmarks for Mac App Store sandbox build.
///
/// MAS apps run inside App Sandbox and lose access to user-selected paths
/// across restarts. Security-Scoped Bookmarks persist that access by storing
/// a cryptographically-signed token that the OS can re-validate later.
///
/// Usage flow:
///   1. User selects a folder via open_dialog → you get a path string.
///   2. Call `save_bookmark(path)` → returns base64-encoded bookmark token.
///   3. Store token in your app config / plist.
///   4. On next launch call `resolve_bookmark(token)` → returns the path and
///      starts security-scoped access. Keep calling file APIs using this path.
///   5. When done with the path call `stop_bookmark_access(path)`.
use tauri::command;

#[allow(unused_imports)]
use objc::runtime::Object;
#[allow(unused_imports)]
use objc::{class, msg_send, sel, sel_impl};

/// Save a Security-Scoped Bookmark for `path`.
/// Returns a base64-encoded bookmark blob to be persisted by the caller.
#[command]
pub fn save_bookmark(path: String) -> Result<String, String> {
    use std::ffi::CString;

    unsafe {
        let c_path = CString::new(path).map_err(|e| e.to_string())?;

        // NSString from UTF-8 path
        let ns_str: *mut Object =
            msg_send![class!(NSString), stringWithUTF8String: c_path.as_ptr()];

        // NSURL from path
        let ns_url: *mut Object = msg_send![class!(NSURL), fileURLWithPath: ns_str];

        // NSURLBookmarkCreationWithSecurityScope = 1 << 11 = 2048
        let options: u32 = 1 << 11;
        let mut error: *mut Object = std::ptr::null_mut();

        let bookmark_data: *mut Object = msg_send![
            ns_url,
            bookmarkDataWithOptions: options
            includingResourceValuesForKeys: std::ptr::null::<Object>()
            relativeToURL: std::ptr::null::<Object>()
            error: &mut error
        ];

        if bookmark_data.is_null() {
            let desc: *mut Object = msg_send![error, localizedDescription];
            let utf8: *const i8 = msg_send![desc, UTF8String];
            let err = std::ffi::CStr::from_ptr(utf8)
                .to_string_lossy()
                .into_owned();
            return Err(err);
        }

        let length: usize = msg_send![bookmark_data, length];
        let bytes: *const u8 = msg_send![bookmark_data, bytes];
        let raw = std::slice::from_raw_parts(bytes, length).to_vec();

        Ok(base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            &raw,
        ))
    }
}

/// Resolve a previously saved Security-Scoped Bookmark.
/// Starts security-scoped access and returns the resolved file path.
/// Pair each successful call with `stop_bookmark_access` when done.
#[command]
pub fn resolve_bookmark(data: String) -> Result<String, String> {
    use base64::Engine as _;
    use objc::runtime::BOOL;

    let raw = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| e.to_string())?;

    unsafe {
        let ns_data: *mut Object = msg_send![
            class!(NSData),
            dataWithBytes: raw.as_ptr()
            length: raw.len()
        ];

        // NSURLBookmarkResolutionWithSecurityScope = 1 << 10 = 1024
        let options: u32 = 1 << 10;
        let mut is_stale: BOOL = 0;
        let mut error: *mut Object = std::ptr::null_mut();

        let ns_url: *mut Object = msg_send![
            class!(NSURL),
            URLByResolvingBookmarkData: ns_data
            options: options
            relativeToURL: std::ptr::null::<Object>()
            bookmarkDataIsStale: &mut is_stale
            error: &mut error
        ];

        if ns_url.is_null() {
            return Err("Failed to resolve Security-Scoped Bookmark".to_string());
        }

        // Start security-scoped resource access
        let _: BOOL = msg_send![ns_url, startAccessingSecurityScopedResource];

        // Extract path string
        let path_obj: *mut Object = msg_send![ns_url, path];
        let utf8: *const i8 = msg_send![path_obj, UTF8String];
        let path = std::ffi::CStr::from_ptr(utf8)
            .to_string_lossy()
            .into_owned();

        Ok(path)
    }
}

/// Stop security-scoped resource access for a path obtained via `resolve_bookmark`.
/// Call this when the app no longer needs access to the bookmarked path.
#[command]
pub fn stop_bookmark_access(path: String) -> Result<(), String> {
    use std::ffi::CString;

    unsafe {
        let c_path = CString::new(path).map_err(|e| e.to_string())?;
        let ns_str: *mut Object =
            msg_send![class!(NSString), stringWithUTF8String: c_path.as_ptr()];
        let ns_url: *mut Object = msg_send![class!(NSURL), fileURLWithPath: ns_str];
        let _: () = msg_send![ns_url, stopAccessingSecurityScopedResource];
        Ok(())
    }
}
