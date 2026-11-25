use crate::mcp::ui_requests::{
    request_is_claimed_or_completed, requests_dir_path, validate_ui_request_id, UiRequest,
    UI_REQUEST_EVENT,
};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime};

static OPEN_UI_READY: AtomicBool = AtomicBool::new(false);
static RUN_UI_READY: AtomicBool = AtomicBool::new(false);
static UI_READY_GENERATION: AtomicU64 = AtomicU64::new(0);

#[tauri::command]
pub fn mcp_ui_ready(kind: String, ready: bool, window: tauri::WebviewWindow) -> Result<(), String> {
    if !is_main_window(window.label()) {
        return Err("Only the main window can mark the MCP UI ready".to_string());
    }
    match kind.as_str() {
        "open_files" | "list_visible_tabs" => OPEN_UI_READY.store(ready, Ordering::Release),
        "run_visible_tab" => RUN_UI_READY.store(ready, Ordering::Release),
        _ => return Err(format!("Unknown MCP UI readiness kind: {kind}")),
    }
    UI_READY_GENERATION.fetch_add(1, Ordering::AcqRel);
    Ok(())
}

#[tauri::command]
pub fn claim_mcp_ui_request(id: String, window: tauri::WebviewWindow) -> Result<bool, String> {
    if !is_main_window(window.label()) {
        return Err("Only the main window can claim an MCP UI request".to_string());
    }
    validate_ui_request_id(&id)?;
    let dir = requests_dir_path();
    crate::mcp::ui_requests::create_private_requests_dir(&dir)?;
    crate::mcp::ui_requests::claim_ui_request(&dir, &id)
}

fn is_main_window(label: &str) -> bool {
    label == "main"
}

fn is_ready_for_kind(kind: &str) -> bool {
    is_ready_for_kind_with(
        kind,
        OPEN_UI_READY.load(Ordering::Acquire),
        RUN_UI_READY.load(Ordering::Acquire),
    )
}

fn is_ready_for_kind_with(kind: &str, open_ready: bool, run_ready: bool) -> bool {
    match kind {
        "open_files" | "list_visible_tabs" => open_ready,
        "run_visible_tab" => run_ready,
        _ => false,
    }
}

fn retain_claimed_requests(emitted: &mut HashSet<String>, dir: &std::path::Path) {
    emitted.retain(|id| request_is_claimed_or_completed(dir, id));
}

#[tauri::command]
pub fn write_mcp_ui_response(path: String, content: String) -> Result<(), String> {
    let dir = requests_dir_path();
    crate::mcp::ui_requests::create_private_requests_dir(&dir)?;
    let response_path = std::path::PathBuf::from(&path);
    let name = response_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Invalid MCP UI response path".to_string())?;
    if response_path.parent() != Some(dir.as_path()) || !name.ends_with(".response.json") {
        return Err("MCP UI response path is outside the request directory".to_string());
    }
    if content.len() > 8 * 1024 * 1024 {
        return Err("MCP UI response is too large".to_string());
    }
    let temporary_path = dir.join(format!("{name}.tmp"));
    std::fs::write(&temporary_path, content).map_err(|error| error.to_string())?;
    std::fs::rename(temporary_path, response_path).map_err(|error| error.to_string())
}

pub fn spawn<R: Runtime>(app: AppHandle<R>) {
    crate::async_rt::spawn_blocking(move || {
        if let Err(error) = run_watcher(app) {
            log::warn!("MCP UI request watcher disabled: {error}");
        }
    });
}

fn run_watcher<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let dir = requests_dir_path();
    crate::mcp::ui_requests::create_private_requests_dir(&dir)?;

    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
    let mut watcher: RecommendedWatcher =
        notify::recommended_watcher(tx).map_err(|error| error.to_string())?;
    watcher
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|error| error.to_string())?;

    let mut emitted = HashSet::new();
    let mut scanned_generation = 0;
    loop {
        let generation = UI_READY_GENERATION.load(Ordering::Acquire);
        if generation != scanned_generation {
            scanned_generation = generation;
            retain_claimed_requests(&mut emitted, &dir);
            let entries = std::fs::read_dir(&dir).map_err(|error| error.to_string())?;
            for entry in entries.flatten() {
                emit_request(&app, &dir, entry.path(), &mut emitted);
            }
        }
        let event = match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(event) => event,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
        };
        match event {
            Ok(event) if matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) => {
                for path in event.paths {
                    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                        continue;
                    };
                    if !name.ends_with(".request.json") {
                        continue;
                    }
                    emit_request(&app, &dir, path, &mut emitted);
                }
            }
            Ok(event) if matches!(event.kind, EventKind::Remove(_)) => {
                for path in event.paths {
                    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                        continue;
                    };
                    if let Some(id) = name.strip_suffix(".request.json") {
                        emitted.remove(id);
                    }
                }
            }
            Ok(_) => {}
            Err(error) => log::warn!("MCP UI request watcher error: {error}"),
        }
    }
}

fn emit_request<R: Runtime>(
    app: &AppHandle<R>,
    dir: &std::path::Path,
    path: std::path::PathBuf,
    emitted: &mut HashSet<String>,
) {
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return;
    };
    if !name.ends_with(".request.json") {
        return;
    }
    let content = match std::fs::read(&path) {
        Ok(content) => content,
        Err(error) => {
            log::warn!("Failed to read MCP UI request {}: {error}", path.display());
            return;
        }
    };
    let request = match serde_json::from_slice::<UiRequest>(&content) {
        Ok(request) => request,
        Err(error) => {
            log::warn!(
                "Failed to decode MCP UI request {}: {error}",
                path.display()
            );
            return;
        }
    };
    let expected_response = dir.join(format!("{}.response.json", request.id));
    if !is_ready_for_kind(&request.kind) {
        return;
    }
    if validate_ui_request_id(&request.id).is_err()
        || path != dir.join(format!("{}.request.json", request.id))
        || std::path::Path::new(&request.response_path) != expected_response
        || request_is_claimed_or_completed(dir, &request.id)
        || emitted.contains(&request.id)
    {
        return;
    }
    if request.kind == "open_files" && request.reveal {
        if let Err(error) = reveal_main_window(app) {
            let response = serde_json::json!({"ok": false, "error": error});
            if let Ok(content) = serde_json::to_vec(&response) {
                let temporary_path = dir.join(format!("{}.response.json.tmp", request.id));
                if let Err(write_error) = std::fs::write(&temporary_path, content)
                    .and_then(|()| std::fs::rename(temporary_path, &request.response_path))
                {
                    log::warn!(
                        "Failed to reject MCP UI request {}: {write_error}",
                        request.id
                    );
                }
            }
            return;
        }
    }
    if let Err(error) = app.emit_to("main", UI_REQUEST_EVENT, request) {
        log::warn!("Failed to emit {UI_REQUEST_EVENT}: {error}");
    } else {
        emitted.insert(
            name.strip_suffix(".request.json")
                .unwrap_or_default()
                .to_string(),
        );
    }
}

fn reveal_main_window<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        app.set_activation_policy(tauri::ActivationPolicy::Regular)
            .map_err(|error| format!("Failed to set regular app activation policy: {error}"))?;
        app.show()
            .map_err(|error| format!("Failed to show Tabularis application: {error}"))?;
    }
    let window = app.get_webview_window("main").ok_or_else(|| {
        let mut labels = app.webview_windows().into_keys().collect::<Vec<_>>();
        labels.sort();
        format!(
            "Tabularis main window is unavailable (known windows: {})",
            labels.join(", ")
        )
    })?;
    window
        .center()
        .map_err(|error| format!("Failed to center main window: {error}"))?;
    window
        .show()
        .map_err(|error| format!("Failed to show main window: {error}"))?;
    window
        .unminimize()
        .map_err(|error| format!("Failed to unminimize main window: {error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("Failed to focus main window: {error}"))?;
    let position = window
        .outer_position()
        .map_err(|error| format!("Failed to read main window position: {error}"))?;
    log::info!(
        "MCP reveal state: label={}, visible={}, minimized={}, focused={}, position=({}, {})",
        window.label(),
        window.is_visible().map_err(|error| error.to_string())?,
        window.is_minimized().map_err(|error| error.to_string())?,
        window.is_focused().map_err(|error| error.to_string())?,
        position.x,
        position.y,
    );
    Ok(())
}

#[cfg(test)]
mod tests;
