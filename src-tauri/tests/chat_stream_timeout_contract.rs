use std::fs;
use std::path::PathBuf;

fn start_chat_stream_source() -> String {
    let lib_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs");
    let source = fs::read_to_string(&lib_path)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", lib_path.display()));
    let start = source
        .find("async fn start_chat_stream(")
        .expect("start_chat_stream must remain present");
    let end_offset = source[start..]
        .find("\n/// Cancel the active chat stream.")
        .expect("start_chat_stream must end before cancel_chat_stream");

    source[start..start + end_offset].to_string()
}

#[test]
fn requested_stream_timeout_is_not_a_total_wall_clock_deadline() {
    let source = start_chat_stream_source();

    assert!(
        !source.contains("let stream_deadline ="),
        "timeout_ms is an independent response/first-chunk/idle phase watchdog; \
         start_chat_stream must not convert it into a deadline measured from stream start"
    );
    assert!(
        !source.contains("remaining_stream_timeout"),
        "an active stream may outlive timeout_ms while chunks keep arriving; \
         later phases must not inherit a shrinking remainder"
    );
}

#[test]
fn every_transport_phase_reuses_the_full_requested_timeout() {
    let source = start_chat_stream_source();

    assert!(
        source.contains("let response_timeout = stream_phase_timeout;"),
        "waiting for response headers must receive the full configured phase timeout"
    );
    assert_eq!(
        source
            .matches("let chunk_timeout = stream_phase_timeout;")
            .count(),
        2,
        "the first chunk and every later idle gap must each open a fresh full timeout window"
    );
}
