mod case_store;
mod containment;
mod procfs;
mod tracker;
mod types;

use crate::tracker::TrackerState;
use crate::types::{
    CaseMetadata, CollectorProfile, ContainmentOutcome, ContainmentStatus, GraphSnapshot,
    InspectionCapture, ProcessDetails, ProcessListItem, RecordedCapture, RecordingInfo,
    SessionSummary, SystemOverview, TrackingMessage,
};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use tauri::ipc::Channel;
use tauri::{Manager, State};
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
async fn launch_under_stasis(command: String) -> Result<ProcessListItem, String> {
    tauri::async_runtime::spawn_blocking(move || containment::launch_managed(&command))
        .await
        .map_err(|error| format!("managed launch task failed: {error}"))?
}

#[tauri::command]
fn start_tracking(
    pid: i32,
    start_time_ticks: Option<u64>,
    on_event: Channel<TrackingMessage>,
    state: State<'_, TrackerState>,
) -> Result<String, String> {
    state.begin(pid, start_time_ticks, on_event)
}

#[tauri::command]
fn stop_tracking(session_id: String, state: State<'_, TrackerState>) -> bool {
    state.stop(&session_id)
}

#[tauri::command]
fn promote_tracking_focus(
    session_id: String,
    process_key: String,
    state: State<'_, TrackerState>,
) -> Result<GraphSnapshot, String> {
    state.promote_focus(&session_id, &process_key)
}

#[tauri::command]
fn start_recording(
    session_id: String,
    state: State<'_, TrackerState>,
) -> Result<RecordingInfo, String> {
    state.start_recording(&session_id)
}

#[tauri::command]
fn stop_recording(
    session_id: String,
    state: State<'_, TrackerState>,
) -> Result<RecordingInfo, String> {
    state.stop_recording(&session_id)
}

#[tauri::command]
fn read_recording(
    session_id: String,
    state: State<'_, TrackerState>,
) -> Result<RecordedCapture, String> {
    state.read_recording(&session_id)
}

#[tauri::command]
fn list_recordings(state: State<'_, TrackerState>) -> Result<Vec<SessionSummary>, String> {
    state.list_recordings()
}

#[tauri::command]
fn read_case_metadata(
    session_id: String,
    state: State<'_, TrackerState>,
) -> Result<CaseMetadata, String> {
    state.read_case_metadata(&session_id)
}

#[tauri::command]
fn write_case_metadata(
    session_id: String,
    metadata: CaseMetadata,
    state: State<'_, TrackerState>,
) -> Result<CaseMetadata, String> {
    state.write_case_metadata(&session_id, metadata)
}

#[tauri::command]
fn capture_inspection(
    session_id: String,
    pid: i32,
    start_time_ticks: u64,
    state: State<'_, TrackerState>,
) -> Result<InspectionCapture, String> {
    let process = procfs::inspect_process(pid, Some(start_time_ticks))?;
    state.record_inspection(&session_id, process)
}

#[tauri::command]
fn get_collector_profile() -> CollectorProfile {
    tracker::collector_profile()
}

#[tauri::command]
fn get_containment_status(
    session_id: String,
    state: State<'_, TrackerState>,
) -> Result<ContainmentStatus, String> {
    let snapshot = state.latest_snapshot(&session_id)?;
    Ok(containment::status(&session_id, Some(&snapshot)))
}

#[tauri::command]
async fn set_containment_frozen(
    session_id: String,
    freeze: bool,
    state: State<'_, TrackerState>,
) -> Result<ContainmentOutcome, String> {
    let tracker = state.inner().clone();
    let recording = if tracker.is_recording_active(&session_id) {
        tracker.recording_info(&session_id)?
    } else {
        tracker.start_recording(&session_id)?
    };
    let snapshot = tracker.latest_snapshot(&session_id)?;
    tracker.record_control_request(
        &session_id,
        if freeze { "freeze" } else { "thaw" },
        "desktop-control",
    )?;
    let helper_session = session_id.clone();
    let (status, action) = tauri::async_runtime::spawn_blocking(move || {
        containment::set_frozen(&helper_session, &snapshot, freeze)
    })
    .await
    .map_err(|error| format!("containment task failed: {error}"))??;
    tracker.record_control_action(&session_id, &action)?;
    if freeze {
        let identities = action.affected_processes.clone();
        let inspections = tauri::async_runtime::spawn_blocking(move || {
            identities
                .into_iter()
                .take(256)
                .filter_map(|key| procfs::inspect_process(key.pid, Some(key.start_time_ticks)).ok())
                .collect::<Vec<_>>()
        })
        .await
        .map_err(|error| format!("frozen evidence capture failed: {error}"))?;
        for process in inspections {
            tracker.record_inspection(&session_id, process)?;
        }
    }
    Ok(ContainmentOutcome {
        status,
        action,
        recording,
    })
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
        .setup(|app| {
            let recording_root = app.path().app_data_dir()?.join("recordings");
            app.manage(TrackerState::new(recording_root));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_processes,
            get_process_details,
            get_system_overview,
            launch_under_stasis,
            start_tracking,
            stop_tracking,
            promote_tracking_focus,
            start_recording,
            stop_recording,
            read_recording,
            list_recordings,
            read_case_metadata,
            write_case_metadata,
            capture_inspection,
            get_collector_profile,
            get_containment_status,
            set_containment_frozen,
            write_export
        ])
        .run(tauri::generate_context!())
        .expect("error while running Process Stasis");
}

pub fn privileged_helper_exit_code() -> Option<i32> {
    containment::helper_exit_code_from_args()
}
