use crate::types::CaseMetadata;
use chrono::Utc;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use uuid::Uuid;

const MAX_METADATA_BYTES: u64 = 2 * 1024 * 1024;
const MAX_ANNOTATIONS: usize = 2_000;
const MAX_TEXT_BYTES: usize = 64 * 1024;

pub fn ensure_store(root: &Path) -> Result<(), String> {
    match fs::symlink_metadata(root) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err("case storage location is not a real directory".into());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(root).map_err(|error| error.to_string())?;
        }
        Err(error) => return Err(error.to_string()),
    }
    fs::set_permissions(root, fs::Permissions::from_mode(0o700)).map_err(|error| error.to_string())
}

pub fn validate_session_id(session_id: &str) -> Result<(), String> {
    let parsed = Uuid::parse_str(session_id).map_err(|_| "invalid session identity".to_string())?;
    if parsed.to_string() != session_id.to_lowercase() {
        return Err("session identity is not canonical".into());
    }
    Ok(())
}

pub fn recording_path(root: &Path, session_id: &str) -> Result<PathBuf, String> {
    validate_session_id(session_id)?;
    Ok(root.join(format!("{session_id}.jsonl")))
}

pub fn metadata_path(root: &Path, session_id: &str) -> Result<PathBuf, String> {
    validate_session_id(session_id)?;
    Ok(root.join(format!("{session_id}.case.json")))
}

pub fn default_metadata(session_id: &str) -> CaseMetadata {
    CaseMetadata {
        schema: "process-stasis/case-metadata-v1".into(),
        session_id: session_id.into(),
        title: String::new(),
        summary: String::new(),
        tags: Vec::new(),
        annotations: Vec::new(),
        updated_at: Utc::now().to_rfc3339(),
    }
}

pub fn read_metadata(root: &Path, session_id: &str) -> Result<CaseMetadata, String> {
    ensure_store(root)?;
    let path = metadata_path(root, session_id)?;
    let mut file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(default_metadata(session_id));
        }
        Err(error) => return Err(error.to_string()),
    };
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if metadata.len() > MAX_METADATA_BYTES {
        return Err("case metadata exceeds the 2 MiB safety limit".into());
    }
    let mut content = String::with_capacity(metadata.len() as usize);
    file.read_to_string(&mut content)
        .map_err(|error| error.to_string())?;
    let value: CaseMetadata = serde_json::from_str(&content).map_err(|error| error.to_string())?;
    if value.schema != "process-stasis/case-metadata-v1" || value.session_id != session_id {
        return Err("case metadata identity does not match its file".into());
    }
    Ok(value)
}

pub fn write_metadata(
    root: &Path,
    session_id: &str,
    mut value: CaseMetadata,
) -> Result<CaseMetadata, String> {
    ensure_store(root)?;
    validate_metadata(session_id, &value)?;
    value.schema = "process-stasis/case-metadata-v1".into();
    value.session_id = session_id.into();
    value.updated_at = Utc::now().to_rfc3339();
    let bytes = serde_json::to_vec_pretty(&value).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_METADATA_BYTES {
        return Err("case metadata exceeds the 2 MiB safety limit".into());
    }

    let destination = metadata_path(root, session_id)?;
    let temporary = root.join(format!(".{session_id}-{}.tmp", Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| error.to_string())?;
        fs::rename(&temporary, &destination).map_err(|error| error.to_string())?;
        File::open(root)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| error.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map(|_| value)
}

fn validate_metadata(session_id: &str, value: &CaseMetadata) -> Result<(), String> {
    validate_session_id(session_id)?;
    if !value.session_id.is_empty() && value.session_id != session_id {
        return Err("case metadata belongs to another session".into());
    }
    if value.title.len() > 240 || value.summary.len() > MAX_TEXT_BYTES {
        return Err("case title or summary exceeds its size limit".into());
    }
    if value.tags.len() > 64
        || value
            .tags
            .iter()
            .any(|tag| tag.is_empty() || tag.len() > 64 || tag.chars().any(char::is_control))
    {
        return Err("case tags are invalid".into());
    }
    if value.annotations.len() > MAX_ANNOTATIONS {
        return Err("case has too many annotations".into());
    }
    for annotation in &value.annotations {
        if Uuid::parse_str(&annotation.id).is_err()
            || !matches!(annotation.kind.as_str(), "note" | "bookmark")
            || annotation.body.len() > MAX_TEXT_BYTES
        {
            return Err("case annotation is invalid".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::CaseAnnotation;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn metadata_round_trips_owner_only() {
        let root = std::env::temp_dir().join(format!("process-stasis-case-{}", Uuid::new_v4()));
        let session_id = Uuid::new_v4().to_string();
        let mut value = default_metadata(&session_id);
        value.title = "Synthetic investigation".into();
        value.tags = vec!["triage".into()];
        value.annotations.push(CaseAnnotation {
            id: Uuid::new_v4().to_string(),
            created_at: Utc::now().to_rfc3339(),
            updated_at: Utc::now().to_rfc3339(),
            kind: "note".into(),
            body: "bounded note".into(),
            event_id: None,
            process_key: None,
            snapshot_sequence: None,
        });

        write_metadata(&root, &session_id, value).expect("metadata writes");
        let loaded = read_metadata(&root, &session_id).expect("metadata reads");

        assert_eq!(loaded.title, "Synthetic investigation");
        assert_eq!(loaded.annotations.len(), 1);
        assert_eq!(
            fs::metadata(&root).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let path = metadata_path(&root, &session_id).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );

        fs::remove_file(path).expect("metadata removed");
        fs::remove_dir(root).expect("case directory removed");
    }
}
