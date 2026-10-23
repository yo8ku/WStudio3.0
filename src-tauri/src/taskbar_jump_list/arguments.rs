//! Validate repository launch requests and quote Windows command-line arguments.
use std::{ffi::OsString, path::PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LaunchRequest {
    pub(crate) repository: PathBuf,
    pub(crate) file: Option<PathBuf>,
}

pub(crate) fn repository_argument(args: &[OsString]) -> Result<Option<LaunchRequest>, String> {
    let mut repository = None;
    let mut file = None;
    let mut index = 1;
    while index < args.len() {
        if args[index] == "--open-repository" {
            if repository.is_some() {
                return Err("TASKBAR_REPOSITORY_ARGUMENT_DUPLICATE".into());
            }
            index += 1;
            let value = args
                .get(index)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "TASKBAR_REPOSITORY_ARGUMENT_MISSING".to_string())?;
            let path = PathBuf::from(value);
            if !path.is_absolute() {
                return Err("TASKBAR_REPOSITORY_PATH_NOT_ABSOLUTE".into());
            }
            repository = Some(path);
        } else if args[index] == "--open-file" {
            if file.is_some() {
                return Err("TASKBAR_FILE_ARGUMENT_DUPLICATE".into());
            }
            index += 1;
            let value = args
                .get(index)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "TASKBAR_FILE_ARGUMENT_MISSING".to_string())?;
            let path = PathBuf::from(value);
            if path.is_absolute()
                || path
                    .components()
                    .any(|component| matches!(component, std::path::Component::ParentDir))
            {
                return Err("TASKBAR_FILE_PATH_INVALID".into());
            }
            file = Some(path);
        }
        index += 1;
    }
    if file.is_some() && repository.is_none() {
        return Err("TASKBAR_REPOSITORY_ARGUMENT_REQUIRED".into());
    }
    Ok(repository.map(|repository| LaunchRequest { repository, file }))
}

pub(crate) fn quote_argument(value: &str) -> String {
    let mut result = String::from("\"");
    let mut backslashes = 0;
    for character in value.chars() {
        match character {
            '\\' => backslashes += 1,
            '"' => {
                result.extend(std::iter::repeat('\\').take(backslashes * 2 + 1));
                result.push('"');
                backslashes = 0;
            }
            _ => {
                result.extend(std::iter::repeat('\\').take(backslashes));
                result.push(character);
                backslashes = 0;
            }
        }
    }
    result.extend(std::iter::repeat('\\').take(backslashes * 2));
    result.push('"');
    result
}

pub(crate) fn launch_arguments(path: &str) -> String {
    format!("--open-repository {}", quote_argument(path))
}

pub(crate) fn launch_file_arguments(repository: &str, relative_path: &str) -> String {
    format!(
        "--open-repository {} --open-file {}",
        quote_argument(repository),
        quote_argument(relative_path)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_repository_and_relative_file_launch_requests() {
        let args = [
            "wstudio.exe",
            "--open-repository",
            r"E:\\仓库",
            "--open-file",
            "notes/readme.md",
        ];
        assert_eq!(
            repository_argument(&args.map(OsString::from)).unwrap(),
            Some(LaunchRequest {
                repository: PathBuf::from(r"E:\\仓库"),
                file: Some(PathBuf::from("notes/readme.md")),
            })
        );
    }

    #[test]
    fn launches_unicode_repository_with_spaces_without_splitting_the_path() {
        let args = [
            "wstudio.exe",
            "--open-repository",
            r"E:\我的仓库\notes space",
        ];
        assert_eq!(
            repository_argument(&args.map(OsString::from)).unwrap(),
            Some(LaunchRequest {
                repository: PathBuf::from(r"E:\我的仓库\notes space"),
                file: None,
            })
        );
        assert_eq!(
            quote_argument(r"E:\我的仓库\notes space"),
            r#""E:\我的仓库\notes space""#
        );
    }

    #[test]
    fn rejects_missing_empty_relative_and_duplicate_repository_requests() {
        for args in [
            vec!["wstudio.exe", "--open-repository"],
            vec!["wstudio.exe", "--open-repository", ""],
            vec!["wstudio.exe", "--open-repository", "notes"],
            vec![
                "wstudio.exe",
                "--open-repository",
                r"E:\notes",
                "--open-repository",
                r"E:\other",
            ],
        ] {
            assert!(
                repository_argument(&args.into_iter().map(OsString::from).collect::<Vec<_>>())
                    .is_err()
            );
        }
        assert_eq!(
            repository_argument(&[OsString::from("wstudio.exe")]).unwrap(),
            None
        );
    }

    #[test]
    fn escapes_quotes_and_trailing_backslashes_for_windows_shell_links() {
        assert_eq!(quote_argument(r"E:\notes\"), r#""E:\notes\\""#);
        assert_eq!(quote_argument("a\"b"), "\"a\\\"b\"");
        assert_eq!(quote_argument(""), "\"\"");
    }

    #[test]
    fn jump_list_launches_only_the_selected_repository() {
        assert_eq!(
            launch_arguments(r"E:\我的仓库\notes space"),
            r#"--open-repository "E:\我的仓库\notes space""#
        );
        assert_eq!(
            launch_file_arguments(r"E:\我的仓库", "notes/readme.md"),
            r#"--open-repository "E:\我的仓库" --open-file "notes/readme.md""#
        );
    }
}
