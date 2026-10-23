//! Native settings picker: keep chosen files/folders inside the active workspace.
use super::{workspace_root, WorkspaceState};
use serde::Deserialize;
use std::path::Path;
use tauri::{AppHandle, Manager, Window};
use tauri_plugin_dialog::DialogExt;

#[derive(Deserialize)]
pub(crate) struct PickOptions {
    kind: String,
    #[serde(default)]
    extensions: Vec<String>,
}

impl PickOptions {
    /// Normalize dot-prefixed SDK filters and reject malformed host requests.
    fn validate(mut self) -> Result<Self, String> {
        if !matches!(self.kind.as_str(), "file" | "folder") || self.extensions.len() > 64 {
            return Err("WORKSPACE_PICK_ENTRY_INVALID".into());
        }
        for extension in &mut self.extensions {
            *extension = extension.trim().to_ascii_lowercase();
            let rest = extension
                .strip_prefix('.')
                .ok_or("WORKSPACE_PICK_ENTRY_INVALID")?;
            if rest.is_empty()
                || rest.len() > 64
                || !rest.as_bytes()[0].is_ascii_alphanumeric()
                || !rest.bytes().all(|b| {
                    b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-')
                })
            {
                return Err("WORKSPACE_PICK_ENTRY_INVALID".into());
            }
        }
        Ok(self)
    }
}

/// Resolve actual targets before containment/type checks; return only relative public paths.
fn normalize_selection(root: &Path, selected: &Path, options: &PickOptions) -> Option<String> {
    let root = root.canonicalize().ok()?;
    let selected = selected.canonicalize().ok()?;
    let relative = selected.strip_prefix(&root).ok()?;
    if (options.kind == "file" && !selected.is_file())
        || (options.kind == "folder" && !selected.is_dir())
    {
        return None;
    }
    if options.kind == "file" && !options.extensions.is_empty() {
        let name = selected.file_name()?.to_str()?.to_lowercase();
        if !options
            .extensions
            .iter()
            .any(|extension| name.ends_with(extension))
        {
            return None;
        }
    }
    let relative = relative.to_str()?.replace('\\', "/");
    Some(if relative.is_empty() {
        ".".into()
    } else {
        relative
    })
}

/// Bind the native modal to its caller and reject selections after a repository switch.
#[tauri::command]
pub(crate) async fn workspace_pick_entry(
    options: PickOptions,
    app: AppHandle,
    window: Window,
) -> Result<Option<String>, String> {
    let options = options.validate()?;
    let root = workspace_root(&app.state::<WorkspaceState>())?;
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let parent = app
            .get_window(&label)
            .ok_or("WORKSPACE_PICK_WINDOW_CLOSED")?;
        let mut dialog = app
            .dialog()
            .file()
            .set_parent(&parent)
            .set_directory(&root)
            .set_title(if options.kind == "file" {
                "选择工作区文件"
            } else {
                "选择工作区目录"
            });
        if options.kind == "file" && !options.extensions.is_empty() {
            let filters: Vec<_> = options.extensions.iter().map(|ext| &ext[1..]).collect();
            dialog = dialog.add_filter("允许的文件", &filters);
        }
        let selected = if options.kind == "file" {
            dialog.blocking_pick_file()
        } else {
            dialog.blocking_pick_folder()
        };
        if app.get_window(&label).is_none() {
            return Err("WORKSPACE_PICK_WINDOW_CLOSED".into());
        }
        let Some(selected) = selected else {
            return Ok(None);
        };
        if workspace_root(&app.state::<WorkspaceState>())? != root {
            return Ok(None);
        }
        let selected = selected
            .into_path()
            .map_err(|_| "WORKSPACE_PICK_ENTRY_INVALID")?;
        Ok(normalize_selection(&root, &selected, &options))
    })
    .await
    .map_err(|_| "WORKSPACE_PICK_ENTRY_FAILED".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    /// Remove all generated picker fixtures on success or assertion failure.
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("wstudio-entry-picker-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(path.join("repo/nested")).unwrap();
            fs::create_dir_all(path.join("outside")).unwrap();
            fs::write(path.join("repo/nested/note.MD"), b"text").unwrap();
            fs::write(path.join("repo/nested/note.txt"), b"text").unwrap();
            fs::write(path.join("outside/note.md"), b"text").unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn filters_normalize_dots_case_and_reject_bad_kinds_or_extensions() {
        let options = PickOptions {
            kind: "file".into(),
            extensions: vec![" .MD ".into(), ".tar.gz".into()],
        }
        .validate()
        .unwrap();
        assert_eq!(options.extensions, vec![".md", ".tar.gz"]);
        for extension in ["md", ".", "../", ".a/../b", ".md;*.exe"] {
            assert_eq!(
                PickOptions {
                    kind: "file".into(),
                    extensions: vec![extension.into()]
                }
                .validate()
                .err()
                .unwrap(),
                "WORKSPACE_PICK_ENTRY_INVALID"
            );
        }
        assert!(PickOptions {
            kind: "any".into(),
            extensions: vec![]
        }
        .validate()
        .is_err());
    }

    #[test]
    fn selected_entries_match_type_extension_and_workspace_without_leaking_absolute_paths() {
        let fixture = Fixture::new();
        let root = fixture.0.join("repo");
        let file = PickOptions {
            kind: "file".into(),
            extensions: vec![".md".into()],
        };
        let folder = PickOptions {
            kind: "folder".into(),
            extensions: vec![],
        };
        assert_eq!(
            normalize_selection(&root, &root.join("nested/note.MD"), &file),
            Some("nested/note.MD".into())
        );
        assert_eq!(
            normalize_selection(&root, &root.join("nested"), &folder),
            Some("nested".into())
        );
        assert_eq!(normalize_selection(&root, &root, &folder), Some(".".into()));
        for selected in [
            root.join("nested"),
            root.join("nested/note.txt"),
            fixture.0.join("outside/note.md"),
            root.join("../outside/note.md"),
            root.join("missing.md"),
        ] {
            assert_eq!(normalize_selection(&root, &selected, &file), None);
        }
        assert_eq!(
            normalize_selection(&root, &root.join("nested/note.MD"), &folder),
            None
        );
        let unfiltered = PickOptions {
            kind: "file".into(),
            extensions: vec![],
        };
        assert_eq!(
            normalize_selection(&root, &root.join("nested/note.txt"), &unfiltered),
            Some("nested/note.txt".into())
        );
    }
}
