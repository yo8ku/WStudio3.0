//! Load the public backend origin from the native build configuration.
use std::{env, fs, path::Path};

const ENV_FILE: &str = ".env";
const SERVER_URL_KEY: &str = "WSTUDIO_SERVER_URL";

fn main() {
    println!("cargo:rerun-if-changed={ENV_FILE}");
    println!("cargo:rerun-if-env-changed={SERVER_URL_KEY}");
    let env_path = env::var_os("CARGO_MANIFEST_DIR")
        .map(|value| Path::new(&value).join(ENV_FILE))
        .unwrap_or_else(|| Path::new(ENV_FILE).to_owned());
    if let Some(value) = env::var(SERVER_URL_KEY)
        .ok()
        .or_else(|| dotenv_value(&env_path, SERVER_URL_KEY))
    {
        println!("cargo:rustc-env={SERVER_URL_KEY}={value}");
    }
    tauri_build::build()
}

fn dotenv_value(path: &Path, key: &str) -> Option<String> {
    let contents = fs::read_to_string(path).ok()?;
    contents.lines().find_map(|line| {
        let line = line.trim();
        let line = line.strip_prefix("export ").unwrap_or(line).trim_start();
        if line.is_empty() || line.starts_with('#') {
            return None;
        }
        let (name, raw_value) = line.split_once('=')?;
        if name.trim() != key {
            return None;
        }
        let value = raw_value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|value| value.strip_suffix('"'))
            .or_else(|| {
                value
                    .strip_prefix('\'')
                    .and_then(|value| value.strip_suffix('\''))
            })
            .unwrap_or(value);
        Some(value.to_owned())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_server_url_from_dotenv_lines() {
        let path = std::env::temp_dir().join(format!("wstudio-build-{}.env", std::process::id()));
        fs::write(
            &path,
            "# comment\nOTHER=value\nexport WSTUDIO_SERVER_URL=\"http://localhost:8080\"\n",
        )
        .unwrap();
        assert_eq!(
            dotenv_value(&path, SERVER_URL_KEY).as_deref(),
            Some("http://localhost:8080")
        );
        let _ = fs::remove_file(path);
    }
}
