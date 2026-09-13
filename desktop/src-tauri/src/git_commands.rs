use git2::{BranchType, Repository, Sort, StatusOptions, StashApplyOptions};
use serde::Serialize;
use std::path::Path;
use tauri::command;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus {
    pub path: String,
    pub status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub oid: String,
    pub message: String,
    pub author: String,
    pub time: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoStatus {
    pub root: String,
    pub head: String,
    pub files: Vec<GitFileStatus>,
    pub branches: Vec<GitBranch>,
}

/// Find the git repository root for any path inside a repo.
#[command]
pub fn git_find_root(path: String) -> Result<String, String> {
    let repo = Repository::discover(&path).map_err(|e| e.to_string())?;
    let workdir = repo.workdir().ok_or("Bare repository")?;
    Ok(workdir.to_string_lossy().into_owned())
}

/// Return branch list, changed files, and recent commits for the repo
/// containing `path`.
#[command]
pub fn git_repo_status(path: String) -> Result<GitRepoStatus, String> {
    let repo = Repository::discover(&path).map_err(|e| e.to_string())?;
    let root = repo
        .workdir()
        .ok_or("Bare repository")?
        .to_string_lossy()
        .into_owned();

    // Current HEAD: branch shorthand or abbreviated commit hash
    let head = match repo.head() {
        Ok(r) => {
            if r.is_branch() {
                r.shorthand().unwrap_or("HEAD").to_string()
            } else {
                r.target()
                    .map(|oid| oid.to_string()[..7].to_string())
                    .unwrap_or_else(|| "HEAD".to_string())
            }
        }
        Err(_) => "HEAD".to_string(),
    };

    // Working-tree / index status
    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;

    let mut files: Vec<GitFileStatus> = Vec::new();
    for entry in statuses.iter() {
        let path = entry.path().unwrap_or("").to_string();
        let s = entry.status();
        let label = if s.contains(git2::Status::INDEX_NEW) {
            "staged-new"
        } else if s.contains(git2::Status::INDEX_MODIFIED) {
            "staged-modified"
        } else if s.contains(git2::Status::INDEX_DELETED) {
            "staged-deleted"
        } else if s.contains(git2::Status::WT_MODIFIED) {
            "modified"
        } else if s.contains(git2::Status::WT_DELETED) {
            "deleted"
        } else if s.contains(git2::Status::WT_NEW) {
            "untracked"
        } else {
            continue; // ignored / clean
        };
        files.push(GitFileStatus {
            path,
            status: label.to_string(),
        });
    }

    // All branches (local + remote)
    let branch_iter = repo.branches(None).map_err(|e| e.to_string())?;
    let mut branches: Vec<GitBranch> = Vec::new();
    for b in branch_iter {
        let (branch, btype) = b.map_err(|e| e.to_string())?;
        let name = branch
            .name()
            .map_err(|e| e.to_string())?
            .unwrap_or("")
            .to_string();
        if name.is_empty() {
            continue;
        }
        branches.push(GitBranch {
            name,
            is_current: branch.is_head(),
            is_remote: btype == BranchType::Remote,
        });
    }

    Ok(GitRepoStatus {
        root,
        head,
        files,
        branches,
    })
}

/// Stage one or more files (paths relative to repo root, or absolute).
#[command]
pub fn git_stage(repo_path: String, paths: Vec<String>) -> Result<(), String> {
    let repo = Repository::discover(&repo_path).map_err(|e| e.to_string())?;
    let workdir = repo.workdir().ok_or("Bare repository")?;
    let mut index = repo.index().map_err(|e| e.to_string())?;

    for p in &paths {
        // Accept both absolute and repo-relative paths.
        let rel = if Path::new(p).is_absolute() {
            Path::new(p)
                .strip_prefix(workdir)
                .map_err(|_| format!("Path not in repo: {}", p))?
                .to_path_buf()
        } else {
            Path::new(p).to_path_buf()
        };
        index.add_path(&rel).map_err(|e| e.to_string())?;
    }
    index.write().map_err(|e| e.to_string())?;
    Ok(())
}

/// Unstage one or more files (reset HEAD → index).
#[command]
pub fn git_unstage(repo_path: String, paths: Vec<String>) -> Result<(), String> {
    let repo = Repository::discover(&repo_path).map_err(|e| e.to_string())?;

    // On an empty repo there is no HEAD; fall back to clearing the index entry.
    match repo.head() {
        Ok(head_ref) => {
            let head_commit = head_ref.peel_to_commit().map_err(|e| e.to_string())?;
            repo.reset_default(
                Some(head_commit.as_object()),
                paths.iter().map(|s| s.as_str()),
            )
            .map_err(|e| e.to_string())?;
        }
        Err(_) => {
            // Empty repo: remove entries from index directly.
            let mut index = repo.index().map_err(|e| e.to_string())?;
            for p in &paths {
                index.remove_path(Path::new(p)).ok();
            }
            index.write().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Commit all staged changes with the given message.
#[command]
pub fn git_commit(repo_path: String, message: String) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("コミットメッセージが空です".to_string());
    }
    let repo = Repository::discover(&repo_path).map_err(|e| e.to_string())?;
    let mut index = repo.index().map_err(|e| e.to_string())?;
    let tree_oid = index.write_tree().map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_oid).map_err(|e| e.to_string())?;

    let sig = repo.signature().map_err(|e| e.to_string())?;

    let parent_commits: Vec<git2::Commit> = match repo.head() {
        Ok(head) => {
            let c = head.peel_to_commit().map_err(|e| e.to_string())?;
            vec![c]
        }
        Err(_) => vec![], // first commit
    };
    let parents: Vec<&git2::Commit> = parent_commits.iter().collect();

    let oid = repo
        .commit(Some("HEAD"), &sig, &sig, &message, &tree, &parents)
        .map_err(|e| e.to_string())?;

    Ok(oid.to_string()[..7].to_string())
}

/// Switch to a local branch. Returns an error if the working tree is dirty.
#[command]
pub fn git_checkout_branch(repo_path: String, branch: String) -> Result<(), String> {
    let repo = Repository::discover(&repo_path).map_err(|e| e.to_string())?;
    let obj = repo
        .revparse_single(&format!("refs/heads/{}", branch))
        .map_err(|_| format!("Branch not found: {}", branch))?;
    repo.checkout_tree(&obj, None).map_err(|e| e.to_string())?;
    repo.set_head(&format!("refs/heads/{}", branch))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Return commits for the repo containing `path`, with pagination.
#[command]
pub fn git_log(repo_path: String, limit: usize, offset: usize) -> Result<Vec<GitCommit>, String> {
    let repo = Repository::discover(&repo_path).map_err(|e| e.to_string())?;
    let mut revwalk = repo.revwalk().map_err(|e| e.to_string())?;
    let _ = revwalk.push_head();
    revwalk.set_sorting(Sort::TIME).map_err(|e| e.to_string())?;

    // Skip `offset` entries cheaply — no find_commit overhead for discarded commits
    for _ in 0..offset {
        match revwalk.next() {
            Some(Ok(_)) => {}
            _ => return Ok(Vec::new()),
        }
    }
    let mut commits: Vec<GitCommit> = Vec::new();
    for _ in 0..limit {
        let oid = match revwalk.next() {
            Some(Ok(oid)) => oid,
            _ => break,
        };
        let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
        commits.push(GitCommit {
            oid: oid.to_string(),
            message: commit.summary().unwrap_or("").to_string(),
            author: commit.author().name().unwrap_or("").to_string(),
            time: commit.time().seconds(),
        });
    }
    Ok(commits)
}

/// Return the unified diff for a specific commit (show).
#[command]
pub fn git_show(repo_path: String, oid: String) -> Result<String, String> {
    let repo = Repository::discover(&repo_path).map_err(|e| e.to_string())?;
    let obj = repo.revparse_single(&oid).map_err(|e| e.to_string())?;
    let commit = obj.peel_to_commit().map_err(|e| e.to_string())?;

    let commit_tree = commit.tree().map_err(|e| e.to_string())?;
    let parent_tree = if commit.parent_count() > 0 {
        let parent = commit.parent(0).map_err(|e| e.to_string())?;
        Some(parent.tree().map_err(|e| e.to_string())?)
    } else {
        None
    };

    let diff = repo
        .diff_tree_to_tree(parent_tree.as_ref(), Some(&commit_tree), None)
        .map_err(|e| e.to_string())?;

    let mut result = String::new();
    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        let prefix = match line.origin() {
            '+' => "+",
            '-' => "-",
            ' ' => " ",
            _ => "",
        };
        let content = std::str::from_utf8(line.content()).unwrap_or("");
        result.push_str(prefix);
        result.push_str(content);
        if !content.ends_with('\n') {
            result.push('\n');
        }
        true
    })
    .map_err(|e| e.to_string())?;

    Ok(result)
}

/// Stash entry metadata
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStashEntry {
    pub index: usize,
    pub message: String,
}

/// List all stash entries.
#[command]
pub fn git_stash_list(repo_path: String) -> Result<Vec<GitStashEntry>, String> {
    let mut repo = Repository::discover(&repo_path).map_err(|e| e.to_string())?;
    let mut entries: Vec<GitStashEntry> = Vec::new();
    repo.stash_foreach(|index, msg, _oid| {
        entries.push(GitStashEntry { index, message: msg.to_string() });
        true
    })
    .map_err(|e| e.to_string())?;
    Ok(entries)
}

/// Apply a stash entry by index (reinstates the stash, keeps it in the list).
#[command]
pub fn git_stash_apply(repo_path: String, index: usize) -> Result<(), String> {
    let mut repo = Repository::discover(&repo_path).map_err(|e| e.to_string())?;
    let mut opts = StashApplyOptions::new();
    repo.stash_apply(index, Some(&mut opts)).map_err(|e| e.to_string())
}

/// Drop (delete) a stash entry by index.
#[command]
pub fn git_stash_drop(repo_path: String, index: usize) -> Result<(), String> {
    let mut repo = Repository::discover(&repo_path).map_err(|e| e.to_string())?;
    repo.stash_drop(index).map_err(|e| e.to_string())
}

/// Pop a stash entry (apply + drop).
#[command]
pub fn git_stash_pop(repo_path: String, index: usize) -> Result<(), String> {
    let mut repo = Repository::discover(&repo_path).map_err(|e| e.to_string())?;
    let mut opts = StashApplyOptions::new();
    repo.stash_pop(index, Some(&mut opts)).map_err(|e| e.to_string())
}

/// Save current working changes as a new stash.
#[command]
pub fn git_stash_save(repo_path: String, message: String) -> Result<(), String> {
    let mut repo = Repository::discover(&repo_path).map_err(|e| e.to_string())?;
    let sig = repo.signature().map_err(|e| e.to_string())?;
    let msg = if message.trim().is_empty() { "WIP" } else { message.trim() };
    repo.stash_save(&sig, msg, None).map_err(|e| e.to_string())?;
    Ok(())
}

/// A single blame line annotation
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameEntry {
    pub line: usize,
    pub oid: String,
    pub author: String,
    pub time: i64,
    pub message: String,
}

/// Return blame annotations for every line of a file.
#[command]
pub fn git_blame(repo_path: String, path: String) -> Result<Vec<BlameEntry>, String> {
    let repo = Repository::discover(&repo_path).map_err(|e| e.to_string())?;
    let workdir = repo.workdir().ok_or("Bare repository")?;
    let rel = if Path::new(&path).is_absolute() {
        Path::new(&path)
            .strip_prefix(workdir)
            .map_err(|_| format!("Path not in repo: {}", path))?
            .to_path_buf()
    } else {
        Path::new(&path).to_path_buf()
    };

    let blame = repo.blame_file(&rel, None).map_err(|e| e.to_string())?;
    let mut entries: Vec<BlameEntry> = Vec::new();

    for hunk in blame.iter() {
        let commit = repo.find_commit(hunk.final_commit_id()).map_err(|e| e.to_string())?;
        let oid = hunk.final_commit_id().to_string()[..7].to_string();
        let author = commit.author().name().unwrap_or("").to_string();
        let time = commit.time().seconds();
        let message = commit.summary().unwrap_or("").to_string();
        let start_line = hunk.final_start_line();
        for i in 0..hunk.lines_in_hunk() {
            entries.push(BlameEntry {
                line: start_line + i,
                oid: oid.clone(),
                author: author.clone(),
                time,
                message: message.clone(),
            });
        }
    }
    Ok(entries)
}

/// Return the unified diff for a single file (working-tree vs HEAD).
/// Returns an empty string for new / untracked files.
#[command]
pub fn git_diff(repo_path: String, path: String) -> Result<String, String> {
    let repo = Repository::discover(&repo_path).map_err(|e| e.to_string())?;
    let _workdir = repo.workdir().ok_or("Bare repository")?;

    let old_tree = repo.head().ok().and_then(|h| h.peel_to_commit().ok()).map(|c| c.tree().ok()).flatten();

    let mut diff_opts = git2::DiffOptions::new();
    diff_opts.pathspec(&path);

    let diff = match old_tree {
        Some(tree) => repo
            .diff_tree_to_workdir_with_index(Some(&tree), Some(&mut diff_opts))
            .map_err(|e| e.to_string())?,
        None => repo
            .diff_tree_to_workdir_with_index(None, Some(&mut diff_opts))
            .map_err(|e| e.to_string())?,
    };

    let mut result = String::new();
    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        let prefix = match line.origin() {
            '+' => "+",
            '-' => "-",
            ' ' => " ",
            _ => "",
        };
        let content = std::str::from_utf8(line.content()).unwrap_or("");
        result.push_str(prefix);
        result.push_str(content);
        if !content.ends_with('\n') {
            result.push('\n');
        }
        true
    })
    .map_err(|e| e.to_string())?;

    Ok(result)
}
