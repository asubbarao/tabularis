//! Requests that need the running desktop editor to read or change its tab state.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(target_os = "macos")]
use std::process::Stdio;
use std::time::Duration;

pub const UI_REQUEST_EVENT: &str = "mcp://ui_request";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiRequest {
    pub id: String,
    pub kind: String,
    pub paths: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_sha256: Option<String>,
    #[serde(default)]
    pub reveal: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    pub response_path: String,
}

pub fn requests_dir_path() -> PathBuf {
    crate::paths::get_app_config_dir().join("mcp_ui_requests")
}

pub(crate) fn claim_ui_request(dir: &Path, id: &str) -> Result<bool, String> {
    validate_ui_request_id(id)?;
    let request_path = dir.join(format!("{id}.request.json"));
    let response_path = dir.join(format!("{id}.response.json"));
    let claim_path = dir.join(format!("{id}.claimed"));

    let metadata = match std::fs::symlink_metadata(&request_path) {
        Ok(metadata) if metadata.file_type().is_file() => metadata,
        Ok(_) => return Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("Could not inspect MCP UI request: {error}")),
    };
    if metadata.len() > 8 * 1024 * 1024 || response_path.exists() {
        return Ok(false);
    }

    let content = std::fs::read(&request_path)
        .map_err(|error| format!("Could not read MCP UI request: {error}"))?;
    let request: UiRequest = serde_json::from_slice(&content)
        .map_err(|error| format!("Invalid MCP UI request: {error}"))?;
    if request.id != id || Path::new(&request.response_path) != response_path {
        return Err("MCP UI request ID or response path does not match".to_string());
    }

    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&claim_path)
    {
        Ok(_claim) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(false),
        Err(error) => return Err(format!("Could not claim MCP UI request: {error}")),
    }

    if !request_path.is_file() || response_path.exists() {
        let _ = std::fs::remove_file(&claim_path);
        return Ok(false);
    }
    Ok(true)
}

pub(crate) fn request_is_claimed_or_completed(dir: &Path, id: &str) -> bool {
    if validate_ui_request_id(id).is_err() {
        return false;
    }
    dir.join(format!("{id}.claimed")).exists() || dir.join(format!("{id}.response.json")).exists()
}

pub(crate) fn validate_ui_request_id(id: &str) -> Result<(), String> {
    let bytes = id.as_bytes();
    if bytes.len() != 36
        || bytes.iter().enumerate().any(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                *byte != b'-'
            } else {
                !byte.is_ascii_hexdigit()
            }
        })
    {
        return Err("Invalid MCP UI request ID".to_string());
    }
    Ok(())
}

fn cleanup_request_files(dir: &Path, id: &str) -> Result<(), String> {
    validate_ui_request_id(id)?;
    let request_path = dir.join(format!("{id}.request.json"));
    match std::fs::remove_file(&request_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Could not remove pending MCP UI request: {error}")),
    }

    let mut cleanup_error = None;
    for path in [
        dir.join(format!("{id}.response.json")),
        dir.join(format!("{id}.claimed")),
        dir.join(format!("{id}.tmp")),
        dir.join(format!("{id}.response.json.tmp")),
    ] {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                cleanup_error.get_or_insert_with(|| {
                    format!("Could not remove MCP UI request artifact: {error}")
                });
            }
        }
    }
    cleanup_error.map_or(Ok(()), Err)
}

pub async fn open_files(
    paths: Vec<String>,
    connection_id: Option<String>,
    reveal: bool,
) -> Result<Value, String> {
    validate_open_files_paths(&paths)?;
    request(
        "open_files",
        paths,
        None,
        None,
        connection_id,
        reveal,
        Duration::from_secs(90),
    )
    .await
}

fn validate_open_files_paths(paths: &[String]) -> Result<(), String> {
    if paths.is_empty() || paths.len() > 20 {
        return Err("Provide between 1 and 20 absolute working-file paths".to_string());
    }
    for path in paths {
        let file = Path::new(path);
        if !file.is_absolute() {
            return Err(format!("Unsupported file path: {path}"));
        }
        let metadata = std::fs::metadata(file)
            .map_err(|error| format!("Could not access working file {path}: {error}"))?;
        if !metadata.is_file() {
            return Err(format!("Working-file path is not a regular file: {path}"));
        }
        if metadata.len() > crate::sql_file::MAX_SQL_FILE_BYTES {
            return Err(format!("Working file is too large: {path}"));
        }
    }
    Ok(())
}

pub async fn list_visible_tabs() -> Result<Value, String> {
    request(
        "list_visible_tabs",
        Vec::new(),
        None,
        None,
        None,
        false,
        Duration::from_secs(30),
    )
    .await
}

pub async fn run_visible_tab(path: String, expected_sha256: String) -> Result<Value, String> {
    validate_run_visible_tab(&path, &expected_sha256)?;
    request(
        "run_visible_tab",
        Vec::new(),
        Some(path),
        Some(expected_sha256),
        None,
        false,
        Duration::from_secs(130),
    )
    .await
}

fn validate_run_visible_tab(path: &str, expected_sha256: &str) -> Result<(), String> {
    let file = Path::new(&path);
    if !file.is_absolute()
        || !matches!(
            file.extension().and_then(|value| value.to_str()),
            Some("sql" | "psql" | "pgsql")
        )
    {
        return Err(format!("Unsupported SQL path: {path}"));
    }
    if expected_sha256.len() != 64 || !expected_sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("expected_sha256 must be a 64-character hexadecimal SHA-256".to_string());
    }
    Ok(())
}

async fn request(
    kind: &str,
    paths: Vec<String>,
    path: Option<String>,
    expected_sha256: Option<String>,
    connection_id: Option<String>,
    reveal: bool,
    timeout: Duration,
) -> Result<Value, String> {
    let dir = requests_dir_path();
    create_private_requests_dir(&dir)?;
    let id = crate::ai_activity::new_uuid();
    let request_path = dir.join(format!("{id}.request.json"));
    let response_path = dir.join(format!("{id}.response.json"));
    let request = UiRequest {
        id: id.clone(),
        kind: kind.to_string(),
        paths,
        path,
        expected_sha256,
        reveal,
        connection_id,
        response_path: response_path.to_string_lossy().to_string(),
    };
    let request_json = serde_json::to_vec(&request).map_err(|error| error.to_string())?;
    let temp_path = dir.join(format!("{id}.tmp"));
    if let Err(error) = std::fs::write(&temp_path, request_json) {
        let _ = cleanup_request_files(&dir, &id);
        return Err(error.to_string());
    }
    if let Err(error) = std::fs::rename(&temp_path, &request_path) {
        let _ = cleanup_request_files(&dir, &id);
        return Err(error.to_string());
    }

    let mut launched_desktop = false;
    if should_launch_desktop(kind, launched_desktop, crate::heartbeat::is_alive()) {
        if let Err(error) = launch_desktop(reveal) {
            let _ = cleanup_request_files(&dir, &id);
            return Err(error);
        }
        launched_desktop = true;
    }

    let response = tokio::time::timeout(timeout, async {
        loop {
            if should_launch_desktop(kind, launched_desktop, crate::heartbeat::is_alive()) {
                launch_desktop(reveal)?;
                launched_desktop = true;
            }
            if response_path.exists() {
                let content = std::fs::read(&response_path).map_err(|error| error.to_string())?;
                let response = serde_json::from_slice::<Value>(&content)
                    .map_err(|error| format!("Invalid desktop response: {error}"))?;
                if response["ok"].as_bool() == Some(false) {
                    return Err(response["error"]
                        .as_str()
                        .unwrap_or("Tabularis could not complete the request")
                        .to_string());
                }
                return Ok(response);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await;
    let result = match response {
        Ok(result) => result,
        Err(_) => Err("Timed out waiting for Tabularis to acknowledge the request".to_string()),
    };

    let _ = cleanup_request_files(&dir, &id);
    result
}

fn should_launch_desktop(kind: &str, launched: bool, heartbeat_alive: bool) -> bool {
    kind == "open_files" && !launched && !heartbeat_alive
}

pub(crate) fn create_private_requests_dir(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn launch_desktop(reveal: bool) -> Result<(), String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    #[cfg(target_os = "macos")]
    {
        let data_dir = std::env::var_os("TABULARIS_DATA_DIR")
            .map(std::path::PathBuf::from)
            .ok_or_else(|| {
                "Cannot safely launch Tabularis without TABULARIS_DATA_DIR".to_string()
            })?;
        let data_dir = validate_data_dir(&data_dir)?;
        let Some(bundle) = executable
            .ancestors()
            .find(|path| path.extension().and_then(|value| value.to_str()) == Some("app"))
        else {
            return Err(
                "Cannot safely launch Tabularis outside its signed desktop app bundle".to_string(),
            );
        };
        let mut command = Command::new("/usr/bin/open");
        if !reveal {
            command.arg("-g");
        }
        let status = command
            .arg("--env")
            .arg(format!("TABULARIS_DATA_DIR={}", data_dir.display()))
            .arg("-a")
            .arg(bundle)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|error| format!("Could not launch Tabularis: {error}"))?;
        if !status.success() {
            return Err(format!(
                "Could not launch Tabularis app bundle (exit status {status})"
            ));
        }
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (executable, reveal);
        Err(
            "Automatic MCP launch is supported only through the signed macOS desktop app bundle"
                .to_string(),
        )
    }
}

fn validate_data_dir(path: &std::path::Path) -> Result<std::path::PathBuf, String> {
    if !path.is_absolute() {
        return Err("TABULARIS_DATA_DIR must be an absolute directory".to_string());
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Cannot resolve TABULARIS_DATA_DIR: {error}"))?;
    if !canonical.is_dir() {
        return Err("TABULARIS_DATA_DIR must be a directory".to_string());
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests;
