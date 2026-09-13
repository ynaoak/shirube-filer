use serde::{Deserialize, Serialize};
use std::process::Command;

/// 許可するバイナリ名（フルパス指定は不可）
const ALLOWED_PROGRAMS: &[&str] = &["7z", "7za", "7zz", "7zr"];

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalCommandResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

fn validate_program(program: &str) -> Result<(), String> {
    if program.contains('/') || program.contains('\\') {
        return Err(format!(
            "フルパス指定は許可されていません。バイナリ名のみ指定してください: {}",
            program
        ));
    }
    let name = std::path::Path::new(program)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(program)
        .to_lowercase();
    if ALLOWED_PROGRAMS.contains(&name.as_str()) {
        return Ok(());
    }
    Err(format!(
        "許可されていないプログラムです: '{}'. 許可リスト: {:?}",
        program, ALLOWED_PROGRAMS
    ))
}

fn validate_args(args: &[String]) -> Result<(), String> {
    for arg in args {
        if arg.contains("..") {
            return Err(format!(
                "パストラバーサルを含む引数は許可されていません: {}",
                arg
            ));
        }
        // Reject absolute paths embedded in flag values (e.g. 7z's -o/etc/passwd).
        // Strip any leading '-' characters to get the value portion of a flag.
        let value = arg.trim_start_matches('-');
        if value.starts_with('/') || value.starts_with('\\') {
            return Err(format!(
                "絶対パスを含む引数は許可されていません: {}",
                arg
            ));
        }
        // Windows drive-letter absolute path (e.g. -oC:\Users\...)
        #[cfg(windows)]
        if value.len() >= 2 {
            let mut chars = value.chars();
            let first = chars.next().map(|c| c.is_ascii_alphabetic()).unwrap_or(false);
            let second = chars.next() == Some(':');
            if first && second {
                return Err(format!(
                    "絶対パスを含む引数は許可されていません: {}",
                    arg
                ));
            }
        }
    }
    Ok(())
}

// 外部プロセス（7-Zip 等）の終了まで待つため、メインスレッドで実行すると
// その間ウィンドウが固まる。バックグラウンドスレッドで実行する。
#[tauri::command(async)]
pub fn run_external_command(
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<ExternalCommandResult, String> {
    validate_program(&program)?;
    validate_args(&args)?;

    let mut cmd = Command::new(&program);
    cmd.args(&args);

    if let Some(dir) = &cwd {
        if !dir.is_empty() {
            let path = std::path::Path::new(dir);
            if !path.exists() {
                return Err(format!("cwdが存在しません: {}", dir));
            }
            cmd.current_dir(path);
        }
    }

    let output = cmd.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!(
                "'{}' が見つかりません。7-ZipがインストールされPATHに含まれているか確認してください。",
                program
            )
        } else {
            e.to_string()
        }
    })?;

    Ok(ExternalCommandResult {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code().unwrap_or(-1),
    })
}
