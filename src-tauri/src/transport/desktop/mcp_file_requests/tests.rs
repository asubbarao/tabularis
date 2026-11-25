use super::{is_main_window, is_ready_for_kind_with, retain_claimed_requests};
use std::collections::HashSet;

#[test]
fn ui_request_readiness_is_main_window_only() {
    assert!(is_main_window("main"));
    assert!(!is_main_window("results"));
    assert!(!is_main_window("plugin"));
}

#[test]
fn readiness_is_separate_for_file_open_and_sql_run() {
    assert!(is_ready_for_kind_with("open_files", true, false));
    assert!(is_ready_for_kind_with("list_visible_tabs", true, false));
    assert!(!is_ready_for_kind_with("run_visible_tab", true, false));
    assert!(is_ready_for_kind_with("run_visible_tab", false, true));
    assert!(!is_ready_for_kind_with("unknown", true, true));
}

#[test]
fn readiness_rescan_releases_emitted_requests_that_were_never_claimed() {
    let directory = tempfile::tempdir().unwrap();
    let id = "7e57f4c2-dc42-4a52-b5b3-711be3ec4901".to_string();
    let mut emitted = HashSet::from([id.clone()]);

    retain_claimed_requests(&mut emitted, directory.path());

    assert!(!emitted.contains(&id));
}

#[test]
fn readiness_rescan_keeps_claimed_and_completed_requests_suppressed() {
    let directory = tempfile::tempdir().unwrap();
    let claimed = "7e57f4c2-dc42-4a52-b5b3-711be3ec4901".to_string();
    let completed = "c00b9c3f-d030-46b1-9f70-62c8746fbcc3".to_string();
    std::fs::write(directory.path().join(format!("{claimed}.claimed")), "").unwrap();
    std::fs::write(
        directory.path().join(format!("{completed}.response.json")),
        "{}",
    )
    .unwrap();
    let mut emitted = HashSet::from([claimed.clone(), completed.clone()]);

    retain_claimed_requests(&mut emitted, directory.path());

    assert!(emitted.contains(&claimed));
    assert!(emitted.contains(&completed));
}
