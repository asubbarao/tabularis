use super::{
    claim_ui_request, cleanup_request_files, request_is_claimed_or_completed,
    validate_run_visible_tab, validate_ui_request_id, UiRequest,
};
use std::sync::{Arc, Barrier};

#[test]
fn run_requires_absolute_sql_path_and_hex_sha256() {
    let hash = "0123456789abcdef".repeat(4);
    assert!(validate_run_visible_tab("/tmp/checks.sql", &hash).is_ok());
    assert!(validate_run_visible_tab("relative/checks.sql", &hash).is_err());
    assert!(validate_run_visible_tab("/tmp/review.md", &hash).is_err());
    assert!(validate_run_visible_tab("/tmp/checks.sql", "not-a-hash").is_err());
}

#[test]
fn visible_run_request_serializes_revision_and_path() {
    let request = UiRequest {
        id: "id".into(),
        kind: "run_visible_tab".into(),
        paths: Vec::new(),
        path: Some("/tmp/checks.sql".into()),
        expected_sha256: Some("a".repeat(64)),
        reveal: true,
        connection_id: None,
        response_path: "/tmp/response.json".into(),
    };
    let value = serde_json::to_value(request).unwrap();
    assert_eq!(value["expectedSha256"], "a".repeat(64));
    assert_eq!(value["path"], "/tmp/checks.sql");
    assert_eq!(value["kind"], "run_visible_tab");
    assert_eq!(value["reveal"], true);
}

#[test]
fn open_files_requires_absolute_paths() {
    assert!(super::validate_open_files_paths(&["relative/foo.custom".into()]).is_err());
}

#[test]
fn open_files_accepts_utf8_unknown_extensions_but_rejects_missing_and_directories() {
    let directory = tempfile::tempdir().unwrap();
    let working_file = directory.path().join("foo.custom");
    std::fs::write(&working_file, "plain text").unwrap();
    let working_file = working_file.to_string_lossy().to_string();

    assert!(super::validate_open_files_paths(&[working_file]).is_ok());
    assert!(super::validate_open_files_paths(&[directory.path().display().to_string()]).is_err());
    assert!(super::validate_open_files_paths(&[directory
        .path()
        .join("gone.env")
        .display()
        .to_string()])
    .is_err());
}

#[test]
fn launch_data_directory_must_be_existing_and_absolute() {
    let directory = tempfile::tempdir().unwrap();
    assert!(super::validate_data_dir(directory.path()).is_ok());
    assert!(super::validate_data_dir(std::path::Path::new("relative-profile")).is_err());
    assert!(super::validate_data_dir(&directory.path().join("missing")).is_err());
}

#[test]
fn reveal_defaults_false_for_older_requests() {
    let request: UiRequest = serde_json::from_value(serde_json::json!({
        "id": "id",
        "kind": "open_files",
        "paths": ["/tmp/review.md"],
        "responsePath": "/tmp/response.json"
    }))
    .unwrap();
    assert!(!request.reveal);
}

#[test]
fn a_retained_heartbeat_does_not_suppress_launch_after_it_goes_stale() {
    assert!(!super::should_launch_desktop("open_files", false, true));
    assert!(super::should_launch_desktop("open_files", false, false));
    assert!(!super::should_launch_desktop("open_files", true, false));
    assert!(!super::should_launch_desktop(
        "run_visible_tab",
        false,
        false
    ));
}

fn write_claimable_request(dir: &std::path::Path, id: &str) {
    let request = UiRequest {
        id: id.into(),
        kind: "open_files".into(),
        paths: vec!["/tmp/readme.md".into()],
        path: None,
        expected_sha256: None,
        reveal: false,
        connection_id: None,
        response_path: dir
            .join(format!("{id}.response.json"))
            .to_string_lossy()
            .to_string(),
    };
    std::fs::write(
        dir.join(format!("{id}.request.json")),
        serde_json::to_vec(&request).unwrap(),
    )
    .unwrap();
}

#[test]
fn request_claim_is_atomic_across_concurrent_callers() {
    let directory = tempfile::tempdir().unwrap();
    let id = "7e57f4c2-dc42-4a52-b5b3-711be3ec4901";
    write_claimable_request(directory.path(), id);
    let barrier = Arc::new(Barrier::new(8));
    let callers = (0..8)
        .map(|_| {
            let barrier = barrier.clone();
            let dir = directory.path().to_path_buf();
            std::thread::spawn(move || {
                barrier.wait();
                claim_ui_request(&dir, id).unwrap()
            })
        })
        .collect::<Vec<_>>();
    let winners = callers
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .filter(|won| *won)
        .count();

    assert_eq!(winners, 1);
    assert!(request_is_claimed_or_completed(directory.path(), id));
    assert!(!claim_ui_request(directory.path(), id).unwrap());
}

#[test]
fn claim_rejects_traversal_and_mismatched_response_paths() {
    let directory = tempfile::tempdir().unwrap();
    assert!(validate_ui_request_id("../request").is_err());

    let id = "7e57f4c2-dc42-4a52-b5b3-711be3ec4901";
    write_claimable_request(directory.path(), id);
    let request_path = directory.path().join(format!("{id}.request.json"));
    let mut request: UiRequest =
        serde_json::from_slice(&std::fs::read(&request_path).unwrap()).unwrap();
    request.response_path = directory
        .path()
        .join("elsewhere.json")
        .to_string_lossy()
        .to_string();
    std::fs::write(&request_path, serde_json::to_vec(&request).unwrap()).unwrap();

    assert!(claim_ui_request(directory.path(), id).is_err());
    assert!(!directory.path().join(format!("{id}.claimed")).exists());
}

#[test]
fn cleanup_removes_request_before_claim_and_response_artifacts() {
    let directory = tempfile::tempdir().unwrap();
    let id = "7e57f4c2-dc42-4a52-b5b3-711be3ec4901";
    write_claimable_request(directory.path(), id);
    std::fs::write(directory.path().join(format!("{id}.claimed")), "").unwrap();
    std::fs::write(directory.path().join(format!("{id}.response.json")), "{}").unwrap();

    cleanup_request_files(directory.path(), id).unwrap();

    assert!(!directory.path().join(format!("{id}.request.json")).exists());
    assert!(!directory
        .path()
        .join(format!("{id}.response.json"))
        .exists());
    assert!(!directory.path().join(format!("{id}.claimed")).exists());
}

#[test]
fn cleanup_keeps_claim_when_pending_request_cannot_be_removed() {
    let directory = tempfile::tempdir().unwrap();
    let id = "7e57f4c2-dc42-4a52-b5b3-711be3ec4901";
    std::fs::create_dir(directory.path().join(format!("{id}.request.json"))).unwrap();
    let claim_path = directory.path().join(format!("{id}.claimed"));
    std::fs::write(&claim_path, "").unwrap();

    assert!(cleanup_request_files(directory.path(), id).is_err());

    assert!(directory.path().join(format!("{id}.request.json")).exists());
    assert!(claim_path.exists());
}
