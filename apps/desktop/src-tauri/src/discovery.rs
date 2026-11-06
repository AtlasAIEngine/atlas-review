//! Backend port discovery file.
//!
//! The desktop app publishes its listening port to a well-known file in the
//! app data dir so the MCP server (or any other consumer) can discover the
//! current port without relying on a snapshot written at setup time. This
//! keeps MCP working even when the backend falls back to a dynamic port or
//! when the preferred port changes between releases.
//!
//! File contract (schema v1):
//! ```json
//! {
//!   "schemaVersion": 1,
//!   "host": "127.0.0.1",
//!   "port": 52779,
//!   "pid": 1234,
//!   "startedAt": "2026-04-17T10:34:00.000Z",
//!   "appVersion": "0.24.6"
//! }
//! ```

use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub const DISCOVERY_FILE_NAME: &str = "backend-port.json";
pub const DISCOVERY_SCHEMA_VERSION: u32 = 1;

#[derive(Serialize)]
struct DiscoveryEntry<'a> {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    host: &'a str,
    port: u16,
    pid: u32,
    #[serde(rename = "startedAt")]
    started_at: String,
    #[serde(rename = "appVersion")]
    app_version: &'a str,
}

pub fn discovery_file_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(DISCOVERY_FILE_NAME)
}

/// Write the discovery file atomically (tmp + rename). Non-fatal on failure —
/// the app keeps running, just without a fresh discovery file.
pub fn write(app_data_dir: &Path, host: &str, port: u16, app_version: &str) {
    if let Err(error) = write_inner(app_data_dir, host, port, app_version) {
        log::warn!(
            "Failed to write backend discovery file at {:?}: {}",
            discovery_file_path(app_data_dir),
            error
        );
    }
}

fn write_inner(app_data_dir: &Path, host: &str, port: u16, app_version: &str) -> Result<(), String> {
    fs::create_dir_all(app_data_dir)
        .map_err(|e| format!("Failed to create app data dir {:?}: {}", app_data_dir, e))?;

    let entry = DiscoveryEntry {
        schema_version: DISCOVERY_SCHEMA_VERSION,
        host,
        port,
        pid: std::process::id(),
        started_at: current_iso_timestamp(),
        app_version,
    };

    let serialized = serde_json::to_string_pretty(&entry)
        .map_err(|e| format!("Failed to serialize discovery entry: {}", e))?;

    let target = discovery_file_path(app_data_dir);
    let tmp = app_data_dir.join(format!("{}.tmp", DISCOVERY_FILE_NAME));

    {
        let mut file = fs::File::create(&tmp)
            .map_err(|e| format!("Failed to create discovery tmp file {:?}: {}", tmp, e))?;
        file.write_all(serialized.as_bytes())
            .map_err(|e| format!("Failed to write discovery tmp file: {}", e))?;
        file.sync_all()
            .map_err(|e| format!("Failed to fsync discovery tmp file: {}", e))?;
    }

    fs::rename(&tmp, &target)
        .map_err(|e| format!("Failed to rename discovery tmp -> {:?}: {}", target, e))?;

    log::info!(
        "Wrote backend discovery file {:?} (host={} port={} pid={})",
        target,
        host,
        port,
        std::process::id()
    );
    Ok(())
}

/// Remove the discovery file. Non-fatal on failure. Called on graceful shutdown
/// so downstream consumers can distinguish "app running on port X" from
/// "app not running".
pub fn remove(app_data_dir: &Path) {
    let target = discovery_file_path(app_data_dir);
    match fs::remove_file(&target) {
        Ok(_) => log::info!("Removed backend discovery file {:?}", target),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => log::warn!(
            "Failed to remove backend discovery file {:?}: {}",
            target,
            error
        ),
    }
}

fn current_iso_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let total_secs = duration.as_secs() as i64;
    let ms = duration.subsec_millis();
    let (year, month, day, hour, minute, second) = split_utc(total_secs);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year, month, day, hour, minute, second, ms
    )
}

/// Split a unix timestamp (seconds since epoch, UTC) into (Y, M, D, h, m, s).
/// Avoids pulling in a time crate just for one timestamp.
fn split_utc(total_secs: i64) -> (i32, u32, u32, u32, u32, u32) {
    let days = total_secs.div_euclid(86_400);
    let seconds_of_day = total_secs.rem_euclid(86_400) as u32;
    let hour = seconds_of_day / 3600;
    let minute = (seconds_of_day % 3600) / 60;
    let second = seconds_of_day % 60;

    // 1970-01-01 was day 0.
    let (year, month, day) = civil_from_days(days);
    (year, month, day, hour, minute, second)
}

// Hinnant's civil_from_days algorithm (public domain, widely-used). Converts
// a unix-epoch day count into a (year, month, day) Gregorian tuple.
fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m as u32, d as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn temp_dir() -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "atlas-discovery-test-{}-{}",
            std::process::id(),
            rand_suffix()
        ));
        std::fs::create_dir_all(&base).unwrap();
        base
    }

    fn rand_suffix() -> String {
        // cheap unique-enough suffix, no rng crate
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        format!("{}", t)
    }

    #[test]
    fn write_creates_file_with_expected_fields() {
        let dir = temp_dir();
        write(&dir, "127.0.0.1", 52779, "9.9.9");
        let file = discovery_file_path(&dir);
        let mut s = String::new();
        fs::File::open(&file).unwrap().read_to_string(&mut s).unwrap();
        assert!(s.contains("\"schemaVersion\": 1"));
        assert!(s.contains("\"host\": \"127.0.0.1\""));
        assert!(s.contains("\"port\": 52779"));
        assert!(s.contains("\"appVersion\": \"9.9.9\""));
        assert!(s.contains("\"pid\":"));
        assert!(s.contains("\"startedAt\":"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_is_atomic_no_tmp_leftover() {
        let dir = temp_dir();
        write(&dir, "127.0.0.1", 1234, "0.0.1");
        let tmp = dir.join(format!("{}.tmp", DISCOVERY_FILE_NAME));
        assert!(discovery_file_path(&dir).exists());
        assert!(!tmp.exists(), "tmp file must be renamed away");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn remove_deletes_file_and_tolerates_missing() {
        let dir = temp_dir();
        write(&dir, "127.0.0.1", 1234, "0.0.1");
        assert!(discovery_file_path(&dir).exists());
        remove(&dir);
        assert!(!discovery_file_path(&dir).exists());
        // second remove on missing file must not panic
        remove(&dir);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_overwrites_previous_entry() {
        let dir = temp_dir();
        write(&dir, "127.0.0.1", 1000, "0.0.1");
        write(&dir, "127.0.0.1", 2000, "0.0.2");
        let mut s = String::new();
        fs::File::open(discovery_file_path(&dir))
            .unwrap()
            .read_to_string(&mut s)
            .unwrap();
        assert!(s.contains("\"port\": 2000"));
        assert!(!s.contains("\"port\": 1000"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn iso_timestamp_format_is_well_formed() {
        let ts = current_iso_timestamp();
        // shape: 2026-04-17T10:34:00.000Z
        assert_eq!(ts.len(), 24, "ts was {:?}", ts);
        assert_eq!(&ts[4..5], "-");
        assert_eq!(&ts[7..8], "-");
        assert_eq!(&ts[10..11], "T");
        assert_eq!(&ts[13..14], ":");
        assert_eq!(&ts[16..17], ":");
        assert_eq!(&ts[19..20], ".");
        assert_eq!(&ts[23..24], "Z");
    }

    #[test]
    fn civil_from_days_known_dates() {
        // Unix epoch = 1970-01-01
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        // 2000-01-01 = day 10957
        assert_eq!(civil_from_days(10_957), (2000, 1, 1));
        // Leap day 2020-02-29 = day 18321
        assert_eq!(civil_from_days(18_321), (2020, 2, 29));
    }
}
