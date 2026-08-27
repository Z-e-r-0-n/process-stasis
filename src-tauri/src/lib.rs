mod procfs;
mod tracker;
mod types;

use crate::tracker::TrackerState;
use crate::types::{ProcessDetails, ProcessListItem, SystemOverview, TrackingMessage};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use tauri::ipc::Channel;
use tauri::State;
use uuid::Uuid;

const MAX_EXPORT_BYTES: usize = 64 * 1024 * 1024;

#[tauri::command]
fn list_processes(query: Option<String>, limit: Option<usize>) -> Vec<ProcessListItem> {
    procfs::list_processes(query.as_deref(), limit.unwrap_or(250))
}

#[tauri::command]
fn get_process_details(pid: i32, start_time_ticks: Option<u64>) -> Result<ProcessDetails, String> {
    procfs::inspect_process(pid, start_time_ticks)
}

#[tauri::command]
fn get_system_overview() -> SystemOverview {
    procfs::system_overview()
}

#[tauri::command]
fn start_tracking(
    pid: i32,
    on_event: Channel<TrackingMessage>,
    state: State<'_, TrackerState>,
) -> Result<String, String> {
    state.begin(pid, on_event)
}

#[tauri::command]
fn stop_tracking(session_id: String, state: State<'_, TrackerState>) -> bool {
    state.stop(&session_id)
}

#[tauri::command]
fn write_export(path: String, content: String) -> Result<(), String> {
    if content.len() > MAX_EXPORT_BYTES {
        return Err("export exceeds the 64 MiB safety limit".into());
    }
    let destination = PathBuf::from(path);
    let parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    if !parent.is_dir() {
        return Err("export directory does not exist".into());
    }
    let temporary = parent.join(format!(".stasis-{}.tmp", Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
        file.write_all(content.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|error| error.to_string())?;
        fs::rename(&temporary, &destination).map_err(|error| error.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(TrackerState::default())
        .invoke_handler(tauri::generate_handler![
            list_processes,
            get_process_details,
            get_system_overview,
            start_tracking,
            stop_tracking,
            write_export
        ])
        .run(tauri::generate_context!())
        .expect("error while running Process Stasis");
}
