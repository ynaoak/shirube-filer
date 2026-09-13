use std::path::PathBuf;

/// Returns the shirube-filer config directory.
/// Windows: %APPDATA%/shirube-filer
/// others:  $HOME/.config/shirube-filer (falls back to temp dir)
pub fn config_dir() -> PathBuf {
    #[cfg(windows)]
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    #[cfg(not(windows))]
    let base = std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    base.join("shirube-filer")
}

/// Returns the addons directory inside the config dir.
pub fn addons_dir() -> PathBuf {
    config_dir().join("addons")
}

/// Build a path by joining `base` with `untrusted`, rejecting any component
/// that would escape `base` (ParentDir / RootDir / Prefix).
/// Returns `None` if the untrusted path tries to escape.
pub fn safe_join(base: &std::path::Path, untrusted: &std::path::Path) -> Option<PathBuf> {
    let mut result = base.to_path_buf();
    for component in untrusted.components() {
        match component {
            std::path::Component::Normal(c) => result.push(c),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir
            | std::path::Component::RootDir
            | std::path::Component::Prefix(_) => return None,
        }
    }
    Some(result)
}
