//! Backend process manager for AtlasEngine Desktop
//!
//! Manages the lifecycle of the Node.js backend process:
//! - Starts the backend when the app launches
//! - Monitors the process and captures stdout/stderr for logging
//! - Gracefully shuts down on app close
//! - Provides IPC commands for the frontend to query backend status

use serde::Serialize;
#[cfg(target_os = "windows")]
use serde::Deserialize;
use std::fs;
use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, Runtime};

#[cfg(target_os = "windows")]
use std::collections::hash_map::DefaultHasher;
#[cfg(target_os = "windows")]
use std::collections::HashSet;
#[cfg(target_os = "windows")]
use std::hash::{Hash, Hasher};
#[cfg(target_os = "windows")]
use std::path::Path;
#[cfg(target_os = "windows")]
use std::time::SystemTime;

/// Backend process state
pub struct BackendState {
    /// The running Node.js process
    process: Option<Child>,
    /// The port the backend is listening on
    port: Option<u16>,
    /// Whether the backend is ready (health check passed)
    ready: bool,
    /// Last error encountered while starting or running the backend
    last_error: Option<String>,
}

impl Default for BackendState {
    fn default() -> Self {
        Self {
            process: None,
            port: None,
            ready: false,
            last_error: None,
        }
    }
}

/// Backend status information for IPC
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendStatus {
    pub running: bool,
    pub ready: bool,
    pub port: Option<u16>,
    pub last_error: Option<String>,
}

fn node_sidecar_name() -> String {
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x86_64",
        "aarch64" => "aarch64",
        other => other,
    };

    if cfg!(target_os = "windows") {
        format!("node-{}-pc-windows-msvc.exe", arch)
    } else if cfg!(target_os = "macos") {
        format!("node-{}-apple-darwin", arch)
    } else {
        format!("node-{}-unknown-linux-gnu", arch)
    }
}

/// Wrapped backend state for thread-safe access
pub type BackendStateWrapper = Arc<Mutex<BackendState>>;

/// Helper to set error in state
fn set_error<R: Runtime>(app: &AppHandle<R>, error: String) {
    let state: tauri::State<BackendStateWrapper> = app.state();
    if let Ok(mut backend) = state.lock() {
        backend.last_error = Some(error);
    }; // Semicolon ensures MutexGuard drops before state
}

fn is_port_available(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

const DEV_PREFERRED_BACKEND_PORT: u16 = 3001;
const PROD_PREFERRED_BACKEND_PORT: u16 = 52779;

#[cfg(target_os = "windows")]
const WINDOWS_RUNTIME_FINGERPRINT_FILENAME: &str = "atlas-runtime-fingerprint.txt";
#[cfg(target_os = "windows")]
const WINDOWS_RUNTIME_MANIFEST_FILENAME: &str = "atlas-runtime-manifest.json";
#[cfg(target_os = "windows")]
const WINDOWS_RUNTIME_READY_SENTINEL_FILENAME: &str = ".runtime-ready";

#[cfg(target_os = "windows")]
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowsRuntimeManifest {
    #[serde(default)]
    native_backend_packages: Vec<String>,
}

#[cfg(target_os = "windows")]
#[derive(Debug, Default)]
struct WindowsRuntimeStageStats {
    copied_native_packages: usize,
    junctioned_packages: usize,
}

struct BackendLaunchPaths {
    node_binary: PathBuf,
    backend_entry: PathBuf,
    mcp_server_root: PathBuf,
}

fn backend_startup_timeout_budget() -> Duration {
    if tauri::is_dev() {
        Duration::from_secs(45)
    } else if cfg!(target_os = "windows") {
        Duration::from_secs(90)
    } else {
        Duration::from_secs(30)
    }
}

fn remaining_timeout(deadline: Instant) -> Duration {
    deadline
        .checked_duration_since(Instant::now())
        .unwrap_or_else(|| Duration::from_secs(0))
}

#[cfg(target_os = "windows")]
fn stable_modified_time(metadata: &fs::Metadata) -> u128 {
    metadata
        .modified()
        .unwrap_or(SystemTime::UNIX_EPOCH)
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

#[cfg(target_os = "windows")]
fn hash_path_metadata(
    path: &Path,
    relative: &Path,
    hasher: &mut DefaultHasher,
) -> Result<(), String> {
    let metadata =
        fs::metadata(path).map_err(|e| format!("Failed to read metadata for {:?}: {}", path, e))?;
    relative.to_string_lossy().hash(hasher);
    metadata.len().hash(hasher);
    stable_modified_time(&metadata).hash(hasher);
    Ok(())
}

#[cfg(target_os = "windows")]
fn hash_directory_metadata(
    root: &Path,
    current: &Path,
    hasher: &mut DefaultHasher,
) -> Result<(), String> {
    let mut entries = fs::read_dir(current)
        .map_err(|e| {
            format!(
                "Failed to read backend runtime source dir {:?}: {}",
                current, e
            )
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| {
            format!(
                "Failed to enumerate backend runtime source dir {:?}: {}",
                current, e
            )
        })?;

    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let path = entry.path();
        let relative = path.strip_prefix(root).map_err(|e| {
            format!(
                "Failed to compute runtime fingerprint path for {:?}: {}",
                path, e
            )
        })?;

        hash_path_metadata(&path, relative, hasher)?;

        if entry
            .file_type()
            .map_err(|e| format!("Failed to read file type for {:?}: {}", path, e))?
            .is_dir()
        {
            hash_directory_metadata(root, &path, hasher)?;
        }
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn copy_directory_recursive(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination)
        .map_err(|e| format!("Failed to create directory {:?}: {}", destination, e))?;

    let mut entries = fs::read_dir(source)
        .map_err(|e| format!("Failed to read source directory {:?}: {}", source, e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to enumerate source directory {:?}: {}", source, e))?;

    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|e| format!("Failed to read file type for {:?}: {}", source_path, e))?;

        if file_type.is_dir() {
            copy_directory_recursive(&source_path, &destination_path)?;
        } else {
            if let Some(parent) = destination_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create directory {:?}: {}", parent, e))?;
            }
            fs::copy(&source_path, &destination_path).map_err(|e| {
                format!(
                    "Failed to copy backend runtime file {:?} to {:?}: {}",
                    source_path, destination_path, e
                )
            })?;
        }
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn read_windows_runtime_manifest(resource_root: &Path) -> Result<WindowsRuntimeManifest, String> {
    let manifest_path = resource_root.join(WINDOWS_RUNTIME_MANIFEST_FILENAME);
    let manifest_contents = fs::read_to_string(&manifest_path)
        .map_err(|e| format!("Failed to read runtime manifest {:?}: {}", manifest_path, e))?;
    serde_json::from_str::<WindowsRuntimeManifest>(&manifest_contents).map_err(|e| {
        format!(
            "Failed to parse runtime manifest {:?}: {}",
            manifest_path, e
        )
    })
}

#[cfg(target_os = "windows")]
fn directory_contains_native_module(dir: &Path) -> Result<bool, String> {
    let mut entries = fs::read_dir(dir)
        .map_err(|e| format!("Failed to read directory {:?}: {}", dir, e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to enumerate directory {:?}: {}", dir, e))?;

    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|e| format!("Failed to read file type for {:?}: {}", path, e))?;

        if file_type.is_dir() {
            if directory_contains_native_module(&path)? {
                return Ok(true);
            }
            continue;
        }

        if file_type.is_file() && path.extension().and_then(|ext| ext.to_str()) == Some("node") {
            return Ok(true);
        }
    }

    Ok(false)
}

#[cfg(target_os = "windows")]
fn detect_native_backend_packages(node_modules_root: &Path) -> Result<Vec<String>, String> {
    if !node_modules_root.exists() {
        return Ok(Vec::new());
    }

    let mut native_packages = Vec::new();
    let mut entries = fs::read_dir(node_modules_root)
        .map_err(|e| {
            format!(
                "Failed to read node_modules dir {:?}: {}",
                node_modules_root, e
            )
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| {
            format!(
                "Failed to enumerate node_modules dir {:?}: {}",
                node_modules_root, e
            )
        })?;
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let entry_path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|e| format!("Failed to read file type for {:?}: {}", entry_path, e))?;
        if !file_type.is_dir() {
            continue;
        }

        let entry_name = entry.file_name().to_string_lossy().into_owned();
        if entry_name.starts_with('@') {
            let mut scoped_entries = fs::read_dir(&entry_path)
                .map_err(|e| format!("Failed to read scoped dir {:?}: {}", entry_path, e))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("Failed to enumerate scoped dir {:?}: {}", entry_path, e))?;
            scoped_entries.sort_by_key(|scoped_entry| scoped_entry.file_name());

            for scoped_entry in scoped_entries {
                let package_path = scoped_entry.path();
                let scoped_type = scoped_entry.file_type().map_err(|e| {
                    format!("Failed to read file type for {:?}: {}", package_path, e)
                })?;
                if !scoped_type.is_dir() {
                    continue;
                }

                if directory_contains_native_module(&package_path)? {
                    native_packages.push(format!(
                        "{}/{}",
                        entry_name,
                        scoped_entry.file_name().to_string_lossy()
                    ));
                }
            }

            continue;
        }

        if directory_contains_native_module(&entry_path)? {
            native_packages.push(entry_name);
        }
    }

    Ok(native_packages)
}

#[cfg(target_os = "windows")]
fn create_directory_junction(target: &Path, junction_path: &Path) -> Result<(), String> {
    if junction_path.exists() {
        remove_junction_or_dir(junction_path)?;
    }

    if let Some(parent) = junction_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory {:?}: {}", parent, e))?;
    }

    junction::create(target, junction_path).map_err(|e| {
        format!(
            "Failed to create directory junction from {:?} to {:?}: {}",
            junction_path, target, e
        )
    })
}

#[cfg(target_os = "windows")]
fn stage_backend_node_modules(
    source_node_modules: &Path,
    staged_node_modules: &Path,
    native_backend_packages: &HashSet<String>,
) -> Result<WindowsRuntimeStageStats, String> {
    fs::create_dir_all(staged_node_modules).map_err(|e| {
        format!(
            "Failed to create staged node_modules dir {:?}: {}",
            staged_node_modules, e
        )
    })?;

    let mut stats = WindowsRuntimeStageStats::default();
    let mut entries = fs::read_dir(source_node_modules)
        .map_err(|e| {
            format!(
                "Failed to read node_modules dir {:?}: {}",
                source_node_modules, e
            )
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| {
            format!(
                "Failed to enumerate node_modules dir {:?}: {}",
                source_node_modules, e
            )
        })?;
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let source_path = entry.path();
        let destination_path = staged_node_modules.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|e| format!("Failed to read file type for {:?}: {}", source_path, e))?;

        if file_type.is_dir() {
            let entry_name = entry.file_name().to_string_lossy().into_owned();

            if entry_name.starts_with('@') {
                fs::create_dir_all(&destination_path).map_err(|e| {
                    format!(
                        "Failed to create scoped node_modules dir {:?}: {}",
                        destination_path, e
                    )
                })?;

                let mut scoped_entries = fs::read_dir(&source_path)
                    .map_err(|e| format!("Failed to read scoped dir {:?}: {}", source_path, e))?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| {
                        format!("Failed to enumerate scoped dir {:?}: {}", source_path, e)
                    })?;
                scoped_entries.sort_by_key(|scoped_entry| scoped_entry.file_name());

                for scoped_entry in scoped_entries {
                    let package_source_path = scoped_entry.path();
                    let package_destination_path = destination_path.join(scoped_entry.file_name());
                    let package_file_type = scoped_entry.file_type().map_err(|e| {
                        format!(
                            "Failed to read file type for {:?}: {}",
                            package_source_path, e
                        )
                    })?;

                    if !package_file_type.is_dir() {
                        fs::copy(&package_source_path, &package_destination_path).map_err(|e| {
                            format!(
                                "Failed to copy staged scoped node_modules file {:?} to {:?}: {}",
                                package_source_path, package_destination_path, e
                            )
                        })?;
                        continue;
                    }

                    let package_name = format!(
                        "{}/{}",
                        entry_name,
                        scoped_entry.file_name().to_string_lossy()
                    );
                    if native_backend_packages.contains(&package_name) {
                        copy_directory_recursive(&package_source_path, &package_destination_path)?;
                        stats.copied_native_packages += 1;
                    } else {
                        create_directory_junction(&package_source_path, &package_destination_path)?;
                        stats.junctioned_packages += 1;
                    }
                }

                continue;
            }

            if native_backend_packages.contains(&entry_name) {
                copy_directory_recursive(&source_path, &destination_path)?;
                stats.copied_native_packages += 1;
            } else {
                create_directory_junction(&source_path, &destination_path)?;
                stats.junctioned_packages += 1;
            }

            continue;
        }

        fs::copy(&source_path, &destination_path).map_err(|e| {
            format!(
                "Failed to copy staged node_modules file {:?} to {:?}: {}",
                source_path, destination_path, e
            )
        })?;
    }

    Ok(stats)
}

#[cfg(target_os = "windows")]
fn stage_windows_resources(
    resource_root: &Path,
    staged_resources_root: &Path,
    native_backend_packages: &[String],
) -> Result<WindowsRuntimeStageStats, String> {
    fs::create_dir_all(staged_resources_root).map_err(|e| {
        format!(
            "Failed to create staged resources dir {:?}: {}",
            staged_resources_root, e
        )
    })?;

    let native_backend_packages: HashSet<String> =
        native_backend_packages.iter().cloned().collect();
    let mut stats = WindowsRuntimeStageStats::default();
    let mut entries = fs::read_dir(resource_root)
        .map_err(|e| format!("Failed to read resource root {:?}: {}", resource_root, e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| {
            format!(
                "Failed to enumerate resource root {:?}: {}",
                resource_root, e
            )
        })?;
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let source_path = entry.path();
        let destination_path = staged_resources_root.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|e| format!("Failed to read file type for {:?}: {}", source_path, e))?;
        let entry_name = entry.file_name().to_string_lossy().into_owned();

        if file_type.is_dir() {
            if entry_name == "backend" {
                fs::create_dir_all(&destination_path).map_err(|e| {
                    format!(
                        "Failed to create staged backend dir {:?}: {}",
                        destination_path, e
                    )
                })?;

                let mut backend_entries = fs::read_dir(&source_path)
                    .map_err(|e| format!("Failed to read backend dir {:?}: {}", source_path, e))?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| {
                        format!("Failed to enumerate backend dir {:?}: {}", source_path, e)
                    })?;
                backend_entries.sort_by_key(|backend_entry| backend_entry.file_name());

                for backend_entry in backend_entries {
                    let backend_source_path = backend_entry.path();
                    let backend_destination_path = destination_path.join(backend_entry.file_name());
                    let backend_file_type = backend_entry.file_type().map_err(|e| {
                        format!(
                            "Failed to read file type for {:?}: {}",
                            backend_source_path, e
                        )
                    })?;
                    let backend_name = backend_entry.file_name().to_string_lossy().into_owned();

                    if backend_file_type.is_dir() {
                        if backend_name == "node_modules" {
                            let node_modules_stats = stage_backend_node_modules(
                                &backend_source_path,
                                &backend_destination_path,
                                &native_backend_packages,
                            )?;
                            stats.copied_native_packages +=
                                node_modules_stats.copied_native_packages;
                            stats.junctioned_packages += node_modules_stats.junctioned_packages;
                        } else {
                            copy_directory_recursive(
                                &backend_source_path,
                                &backend_destination_path,
                            )?;
                        }
                    } else {
                        fs::copy(&backend_source_path, &backend_destination_path).map_err(|e| {
                            format!(
                                "Failed to copy staged backend file {:?} to {:?}: {}",
                                backend_source_path, backend_destination_path, e
                            )
                        })?;
                    }
                }

                continue;
            }

            create_directory_junction(&source_path, &destination_path)?;
            continue;
        }

        fs::copy(&source_path, &destination_path).map_err(|e| {
            format!(
                "Failed to copy staged resource file {:?} to {:?}: {}",
                source_path, destination_path, e
            )
        })?;
    }

    Ok(stats)
}

fn resolve_launch_paths<R: Runtime>(app: &AppHandle<R>) -> Result<BackendLaunchPaths, String> {
    let resource_path_raw = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource directory: {}", e))?;

    // On Windows, Tauri's resource_dir() returns \\?\-prefixed extended-length
    // paths (for example "\\?\D:\..."). Node.js cannot resolve these reliably,
    // so strip the prefix when a normal Win32 path is available.
    let resource_path = dunce::simplified(&resource_path_raw).to_path_buf();

    let exe_path_raw =
        std::env::current_exe().map_err(|e| format!("Failed to get executable path: {}", e))?;
    let exe_path = dunce::simplified(&exe_path_raw).to_path_buf();
    let exe_dir = exe_path
        .parent()
        .ok_or("Failed to get executable directory")?;

    let mut node_binary = if cfg!(target_os = "windows") {
        exe_dir.join("node.exe")
    } else {
        exe_dir.join("node")
    };

    let mut backend_entry = resource_path
        .join("resources")
        .join("backend")
        .join("server-desktop.js");
    let mut mcp_server_root = resource_path.join("resources").join("mcp-review-server");

    log::info!("Checking production paths:");
    log::info!(
        "  node_binary: {:?} (exists: {})",
        node_binary,
        node_binary.exists()
    );
    log::info!(
        "  backend_entry: {:?} (exists: {})",
        backend_entry,
        backend_entry.exists()
    );

    if !node_binary.exists() || !backend_entry.exists() {
        if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
            let dev_path = PathBuf::from(&manifest_dir);

            node_binary = dev_path.join("binaries").join(node_sidecar_name());

            backend_entry = dev_path
                .join("resources")
                .join("backend")
                .join("server-desktop.js");
            mcp_server_root = dev_path
                .join("..")
                .join("..")
                .join("..")
                .join("mcp-review-server");

            log::info!(
                "Using dev mode paths from CARGO_MANIFEST_DIR: {:?}",
                dev_path
            );
            log::info!(
                "  node_binary: {:?} (exists: {})",
                node_binary,
                node_binary.exists()
            );
            log::info!(
                "  backend_entry: {:?} (exists: {})",
                backend_entry,
                backend_entry.exists()
            );
            log::info!(
                "  mcp_server_root: {:?} (exists: {})",
                mcp_server_root,
                mcp_server_root.exists()
            );
        }
    }

    if !node_binary.exists() {
        let msg = format!(
            "Node.js binary not found at: {:?}. Expected a bundled binary for {}-{}. Run apps/desktop/scripts/bundle-backend.js to install.",
            node_binary,
            std::env::consts::OS,
            std::env::consts::ARCH
        );
        set_error(app, msg.clone());
        return Err(msg);
    }

    if !backend_entry.exists() {
        let msg = format!(
            "Backend entry point not found at: {:?}. Run apps/desktop/scripts/bundle-backend.js to bundle backend resources.",
            backend_entry
        );
        set_error(app, msg.clone());
        return Err(msg);
    }

    Ok(BackendLaunchPaths {
        node_binary,
        backend_entry,
        mcp_server_root,
    })
}

#[cfg(target_os = "windows")]
fn stage_windows_runtime<R: Runtime>(
    app: &AppHandle<R>,
    launch_paths: BackendLaunchPaths,
) -> Result<BackendLaunchPaths, String> {
    if tauri::is_dev() {
        return Ok(launch_paths);
    }

    let stage_started = Instant::now();
    let backend_dir = launch_paths
        .backend_entry
        .parent()
        .ok_or("Failed to get backend directory")?;
    let resource_root = backend_dir
        .parent()
        .ok_or("Failed to get resource root for staged runtime")?;

    let fingerprint_started = Instant::now();
    let fingerprint_path = resource_root.join(WINDOWS_RUNTIME_FINGERPRINT_FILENAME);
    let fingerprint = match fs::read_to_string(&fingerprint_path) {
        Ok(contents) => {
            let trimmed = contents.trim();
            if trimmed.is_empty() {
                return Err(format!(
                    "Runtime fingerprint file is empty: {:?}",
                    fingerprint_path
                ));
            }
            log::info!(
                "Loaded Windows runtime fingerprint {} from {:?} in {:?}",
                trimmed,
                fingerprint_path,
                fingerprint_started.elapsed()
            );
            trimmed.to_owned()
        }
        Err(read_error) => {
            log::warn!(
                "Runtime fingerprint file missing at {:?} ({}); falling back to metadata scan",
                fingerprint_path,
                read_error
            );

            let mut hasher = DefaultHasher::new();
            hash_path_metadata(
                &launch_paths.node_binary,
                Path::new("node.exe"),
                &mut hasher,
            )?;
            hash_directory_metadata(resource_root, resource_root, &mut hasher)?;

            let fallback = format!("{:016x}", hasher.finish());
            log::info!(
                "Computed fallback Windows runtime fingerprint {} in {:?}",
                fallback,
                fingerprint_started.elapsed()
            );
            fallback
        }
    };
    let native_backend_packages =
        match read_windows_runtime_manifest(resource_root).map(|manifest| {
            log::info!(
                "Loaded Windows runtime manifest with {} native backend package(s)",
                manifest.native_backend_packages.len()
            );
            manifest.native_backend_packages
        }) {
            Ok(native_backend_packages) => native_backend_packages,
            Err(error) => {
                let node_modules_root = resource_root.join("backend").join("node_modules");
                log::warn!(
                    "{}; falling back to runtime native package detection in {:?}",
                    error,
                    node_modules_root
                );
                let detected = detect_native_backend_packages(&node_modules_root)?;
                log::info!(
                    "Detected {} native backend package(s) at runtime",
                    detected.len()
                );
                detected
            }
        };
    let runtime_root = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Failed to get local app data directory: {}", e))?
        .join("runtime")
        .join(format!(
            "{}-{}-copy",
            app.package_info().version,
            fingerprint
        ));
    let staged_node = runtime_root.join("node.exe");
    let staged_resources_root = runtime_root.join("resources");
    let staged_backend_entry = staged_resources_root
        .join("backend")
        .join("server-desktop.js");
    let staged_mcp_server_root = staged_resources_root.join("mcp-review-server");
    let runtime_ready_sentinel = runtime_root.join(WINDOWS_RUNTIME_READY_SENTINEL_FILENAME);

    if staged_node.exists() && staged_backend_entry.exists() && runtime_ready_sentinel.exists() {
        log::info!(
            "Using staged Windows backend runtime at {:?} (reuse check completed in {:?})",
            runtime_root,
            stage_started.elapsed()
        );
        if let Some(runtime_parent) = runtime_root.parent() {
            spawn_runtime_cleanup(runtime_parent.to_path_buf(), runtime_root.clone());
        }
        return Ok(BackendLaunchPaths {
            node_binary: staged_node,
            backend_entry: staged_backend_entry,
            mcp_server_root: staged_mcp_server_root,
        });
    }

    if runtime_root.exists() {
        log::warn!(
            "Discarding incomplete staged Windows runtime at {:?} (ready sentinel missing)",
            runtime_root
        );
        remove_junction_or_dir(&runtime_root)?;
    }

    fs::create_dir_all(&runtime_root)
        .map_err(|e| format!("Failed to create runtime dir {:?}: {}", runtime_root, e))?;

    // Copy only node.exe (single file, ~85MB) — this must be a real copy because
    // the NSIS installer directory may be read-only or locked during updates.
    let node_copy_started = Instant::now();
    fs::copy(&launch_paths.node_binary, &staged_node).map_err(|e| {
        format!(
            "Failed to copy Node.js runtime from {:?}: {}",
            launch_paths.node_binary, e
        )
    })?;
    log::info!(
        "Staged Windows node runtime copy completed in {:?}",
        node_copy_started.elapsed()
    );

    // Stage a hybrid resource tree: copy only the native-module backend packages
    // that would otherwise lock installer-owned files, and junction the rest.
    let resources_copy_started = Instant::now();
    let resource_stage_stats = stage_windows_resources(
        resource_root,
        &staged_resources_root,
        &native_backend_packages,
    )?;
    log::info!(
        "Staged Windows resources in {:?} (copied {} native package(s), junctioned {} package(s))",
        resources_copy_started.elapsed(),
        resource_stage_stats.copied_native_packages,
        resource_stage_stats.junctioned_packages
    );

    if !staged_backend_entry.exists() {
        return Err(format!(
            "Staged backend entry point missing after runtime copy: {:?}",
            staged_backend_entry
        ));
    }

    fs::write(
        &runtime_ready_sentinel,
        format!("fingerprint={}\nready=1\n", fingerprint),
    )
    .map_err(|e| {
        format!(
            "Failed to write Windows runtime ready sentinel {:?}: {}",
            runtime_ready_sentinel, e
        )
    })?;

    log::info!(
        "Staged Windows runtime at {:?} in {:?}",
        runtime_root,
        stage_started.elapsed()
    );

    if let Some(runtime_parent) = runtime_root.parent() {
        spawn_runtime_cleanup(runtime_parent.to_path_buf(), runtime_root.clone());
    }

    Ok(BackendLaunchPaths {
        node_binary: staged_node,
        backend_entry: staged_backend_entry,
        mcp_server_root: staged_mcp_server_root,
    })
}

#[cfg(target_os = "windows")]
fn spawn_runtime_cleanup(runtime_parent: PathBuf, active_runtime: PathBuf) {
    std::thread::spawn(move || {
        let cleanup_started = Instant::now();

        if !runtime_parent.exists() {
            return;
        }

        let entries = match fs::read_dir(&runtime_parent) {
            Ok(entries) => entries,
            Err(error) => {
                log::warn!(
                    "Failed to enumerate Windows runtime parent {:?}: {}",
                    runtime_parent,
                    error
                );
                return;
            }
        };

        let mut removed = 0usize;
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if path == active_runtime || !path.is_dir() {
                continue;
            }

            match remove_junction_or_dir(&path) {
                Ok(()) => {
                    removed += 1;
                    log::info!("Removed stale Windows runtime {:?}", path);
                }
                Err(error) => {
                    log::warn!(
                        "Failed to remove stale Windows runtime {:?}: {}",
                        path,
                        error
                    );
                }
            }
        }

        log::info!(
            "Windows runtime cleanup removed {} stale director{} in {:?}",
            removed,
            if removed == 1 { "y" } else { "ies" },
            cleanup_started.elapsed()
        );
    });
}

/// Remove a path that may be a directory junction or a regular directory.
#[cfg(target_os = "windows")]
fn remove_junction_or_dir(path: &Path) -> Result<(), String> {
    // For junctions, fs::remove_dir removes just the junction link (not the target).
    // For real directories, we need remove_dir_all.
    if fs::remove_dir(path).is_ok() {
        return Ok(());
    }
    fs::remove_dir_all(path).map_err(|e| format!("Failed to remove {:?}: {}", path, e))
}

/// Start the backend process
///
/// Locates the bundled Node.js binary and backend code, then spawns
/// the process with appropriate environment variables.
pub fn start_backend<R: Runtime>(app: &AppHandle<R>) -> Result<u16, String> {
    let startup_started = Instant::now();
    let startup_timeout_budget = backend_startup_timeout_budget();
    let startup_deadline = Instant::now() + startup_timeout_budget;
    log::info!(
        "Starting backend bootstrap with {:?} total startup budget",
        startup_timeout_budget
    );

    let state: tauri::State<BackendStateWrapper> = app.state();

    // Check if already running (brief lock)
    {
        let backend = state
            .lock()
            .map_err(|e| format!("Failed to lock backend state: {}", e))?;
        if backend.process.is_some() && backend.port.is_some() {
            log::info!("Backend already running on port {}", backend.port.unwrap());
            return Ok(backend.port.unwrap());
        }
    }

    // Clear any previous error (brief lock)
    {
        let mut backend = state
            .lock()
            .map_err(|e| format!("Failed to lock backend state: {}", e))?;
        backend.last_error = None;
    }

    // Resolve paths to bundled resources
    // Production structure (macOS):
    //   Contents/MacOS/atlasengine-desktop (main binary)
    //   Contents/MacOS/node (external binary - bundled via externalBin)
    //   Contents/Resources/resources/backend/server-desktop.js (resources)
    // Dev mode:
    //   src-tauri/binaries/node-aarch64-apple-darwin
    //   src-tauri/resources/backend/server-desktop.js

    let launch_paths = resolve_launch_paths(app)?;
    log::info!(
        "Resolved backend launch paths in {:?}",
        startup_started.elapsed()
    );

    #[cfg(target_os = "windows")]
    let launch_paths = stage_windows_runtime(app, launch_paths)?;
    #[cfg(target_os = "windows")]
    log::info!(
        "Prepared staged Windows runtime in {:?}",
        startup_started.elapsed()
    );

    let node_binary = launch_paths.node_binary;
    let backend_entry = launch_paths.backend_entry;
    let mcp_server_root = launch_paths.mcp_server_root;

    // On Windows, Tauri's resource_dir() returns \\?\-prefixed extended-length
    // paths (e.g. "\\?\D:\...").  Node.js cannot resolve these — its
    // realpathSync crashes with "EISDIR: illegal operation on a directory, lstat 'D:'"
    // because it misparses the prefix.  Use dunce to strip the prefix when the
    // path is short enough for a normal Win32 path (virtually always true).
    log::info!("Starting backend with Node.js at: {:?}", node_binary);
    log::info!("Backend entry point: {:?}", backend_entry);
    log::info!("MCP server root: {:?}", mcp_server_root);

    // Get the backend directory for setting current_dir
    let backend_dir = backend_entry
        .parent()
        .ok_or("Failed to get backend directory")?;

    log::info!("Backend working directory: {:?}", backend_dir);

    // Ensure app data/logs directories exist and pass to backend
    let app_data_dir_raw = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;
    let app_data_dir = dunce::simplified(&app_data_dir_raw).to_path_buf();
    let logs_dir = app_data_dir.join("logs");
    if let Err(e) = fs::create_dir_all(&logs_dir) {
        log::warn!("Failed to create logs directory {:?}: {}", logs_dir, e);
    }

    // Allow an override for a fixed backend port (useful for tests).
    // In desktop production builds, prefer a stable local port so MCP
    // snippets remain valid across app restarts.
    let port_env = match std::env::var("ATLAS_BACKEND_PORT") {
        Ok(value) => match value.parse::<u16>() {
            Ok(_) => value,
            Err(_) => {
                log::warn!(
                    "Invalid ATLAS_BACKEND_PORT value: {} (falling back to dynamic port)",
                    value
                );
                "0".to_string()
            }
        },
        Err(_) => {
            let preferred = if tauri::is_dev() {
                DEV_PREFERRED_BACKEND_PORT
            } else {
                PROD_PREFERRED_BACKEND_PORT
            };

            if is_port_available(preferred) {
                preferred.to_string()
            } else {
                log::warn!(
                    "Preferred backend port {} is in use, falling back to dynamic port. \
                     MCP client configs may need to be refreshed via Settings > MCP.",
                    preferred
                );
                "0".to_string()
            }
        }
    };

    // Spawn the Node.js process with correct working directory.
    // The server-desktop.js uses relative imports so CWD must be the backend dir.
    //
    // SECURITY: Use env_clear() + explicit allowlist instead of env_remove() to
    // guarantee no secrets (ANTHROPIC_API_KEY, JWT_SECRET, ENCRYPTION_KEY,
    // GITHUB_CLIENT_SECRET, VERCEL_TOKEN, DATABASE_URL, etc.) leak from the
    // parent shell into the child process. Only essential system vars and
    // desktop-specific ATLAS_ vars are forwarded.
    let mut cmd = Command::new(&node_binary);
    cmd.arg(&backend_entry)
        .current_dir(backend_dir)
        .env_clear() // Start with empty environment
        // Desktop-specific vars
        .env("ATLAS_DESKTOP_MODE", "true")
        .env("ATLAS_APP_VERSION", app.package_info().version.to_string())
        .env("ATLAS_MCP_SERVER_ROOT", &mcp_server_root)
        .env("ATLAS_MCP_ALLOW_EXTERNAL_SERVER_ROOT", "true")
        .env("ATLAS_DB_TYPE", "sqlite")
        .env("ATLAS_DATA_DIR", &app_data_dir)
        .env("ATLAS_LOGS_DIR", &logs_dir)
        .env("PORT", &port_env) // Let OS assign an available port unless overridden
        .env("NODE_ENV", "production")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Forward a minimal allowlist of explicit desktop test toggles when present.
    // This keeps clean-install simulations deterministic without leaking the
    // rest of the parent shell environment into the bundled backend.
    let safe_atlas_forward_vars = [
        "ATLAS_ENABLE_MCP_SETUP_API",
        "ATLAS_DISABLE_CLI_PROVIDER_DETECTION",
    ];
    for var in &safe_atlas_forward_vars {
        if let Ok(val) = std::env::var(var) {
            cmd.env(var, val);
        }
    }

    // Pass the OS device name through so review-sync guest sessions are labelled
    // with a human-readable name in the admin dashboard instead of the UUID-prefix
    // "Device XXXXXXXX" fallback. Respect an explicitly-set parent value first.
    let device_label_override = std::env::var("ATLAS_REVIEW_SYNC_DEVICE_LABEL").ok();
    let device_label = device_label_override.unwrap_or_else(whoami::devicename);
    let trimmed_device_label = device_label.trim();
    if !trimmed_device_label.is_empty() && trimmed_device_label != "localhost" {
        cmd.env("ATLAS_REVIEW_SYNC_DEVICE_LABEL", trimmed_device_label);
    }

    // Forward essential system env vars if present in parent
    let forward_vars = [
        "PATH",
        "HOME",
        "USER",
        "SHELL",
        "TMPDIR",
        "LANG",
        "LC_ALL",
        "TERM",
        "COLORTERM",
    ];
    for var in &forward_vars {
        if let Ok(val) = std::env::var(var) {
            cmd.env(var, val);
        }
    }

    // macOS-specific: DYLD_LIBRARY_PATH for dynamic libraries
    #[cfg(target_os = "macos")]
    if let Ok(val) = std::env::var("DYLD_LIBRARY_PATH") {
        cmd.env("DYLD_LIBRARY_PATH", val);
    }

    // Windows-specific: system variables required for process execution
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);

        let win_vars = [
            "SystemRoot",
            "SYSTEMDRIVE",
            "APPDATA",
            "LOCALAPPDATA",
            "USERPROFILE",
            "TEMP",
            "TMP",
            "COMSPEC",
            "windir",
        ];
        for var in &win_vars {
            if let Ok(val) = std::env::var(var) {
                cmd.env(var, val);
            }
        }
    }

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            let msg = format!("Failed to spawn Node.js process: {}", e);
            set_error(app, msg.clone());
            return Err(msg);
        }
    };

    // Read stdout to discover the assigned port
    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    // Create channel for port discovery
    let (port_tx, port_rx) = mpsc::channel();

    // Spawn thread to read stdout, discover port, then continue logging
    spawn_stdout_reader(stdout, port_tx);

    // Spawn thread to capture stderr logs
    spawn_log_reader(stderr);

    let port_timeout = remaining_timeout(startup_deadline);
    if port_timeout.is_zero() {
        let msg = "Backend startup budget exhausted before waiting for port".to_string();
        set_error(app, msg.clone());
        let _ = child.kill();
        return Err(msg);
    }

    log::info!(
        "Waiting up to {:?} for backend port announcement",
        port_timeout
    );

    let port = match port_rx.recv_timeout(port_timeout) {
        Ok(Some(port)) => port,
        Ok(None) => {
            let msg = "Backend process ended without announcing port".to_string();
            set_error(app, msg.clone());
            let _ = child.kill();
            return Err(msg);
        }
        Err(_) => {
            let msg = "Timeout waiting for backend port".to_string();
            set_error(app, msg.clone());
            let _ = child.kill();
            return Err(msg);
        }
    };

    log::info!(
        "Backend announced port {} after {:?}",
        port,
        startup_started.elapsed()
    );

    // Publish the process handle and discovered port immediately so the
    // frontend can start first-run setup flows before full backend health
    // passes. The `ready` flag remains false until /health returns 200.
    {
        let mut backend = state
            .lock()
            .map_err(|e| format!("Failed to lock backend state: {}", e))?;
        backend.process = Some(child);
        backend.port = Some(port);
        backend.ready = false;
        backend.last_error = None;
    }

    // Wait for health check
    let health_timeout = remaining_timeout(startup_deadline);
    if health_timeout.is_zero() {
        let msg = "Backend startup budget exhausted before health check".to_string();
        let _ = stop_backend(app);
        set_error(app, msg.clone());
        return Err(msg);
    }

    log::info!(
        "Waiting up to {:?} for backend health check",
        health_timeout
    );

    if let Err(e) = wait_for_health(port, health_timeout) {
        let _ = stop_backend(app);
        set_error(app, e.clone());
        return Err(e);
    }

    log::info!(
        "Backend health check passed after {:?}",
        startup_started.elapsed()
    );

    // Update state with success (brief lock)
    {
        let mut backend = state
            .lock()
            .map_err(|e| format!("Failed to lock backend state: {}", e))?;
        backend.ready = true;
        backend.last_error = None;
    }

    // Publish the confirmed port to the discovery file so MCP clients can find
    // the backend across restarts without needing to re-run setup.
    crate::discovery::write(
        &app_data_dir,
        "127.0.0.1",
        port,
        app.package_info().version.to_string().as_str(),
    );

    Ok(port)
}

/// Spawn thread to read stdout, discover port, then continue logging
///
/// Sends discovered port via channel, then continues logging all output
fn spawn_stdout_reader(stdout: std::process::ChildStdout, port_tx: mpsc::Sender<Option<u16>>) {
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut port_sent = false;

        for line in reader.lines().map_while(Result::ok) {
            log::info!("[backend] {}", line);

            // Try to discover port if not yet found
            if !port_sent {
                if let Some(port) = parse_port_from_line(&line) {
                    let _ = port_tx.send(Some(port));
                    port_sent = true;
                }
            }
        }

        // If stdout closed without finding port, send None
        if !port_sent {
            let _ = port_tx.send(None);
        }
    });
}

/// Parse port number from a log line
fn parse_port_from_line(line: &str) -> Option<u16> {
    if let Some(port_str) = line.strip_prefix("BACKEND_PORT=") {
        let port_str = port_str.trim();
        return port_str.parse().ok();
    }

    // Pattern: "Server listening on port 3001" or "listening on port 3001"
    // or "server running on http://localhost:3001"
    let line_lower = line.to_lowercase();

    // Try various patterns
    if line_lower.contains("listening on port") || line_lower.contains("started on port") {
        // Extract number after "port"
        if let Some(idx) = line_lower.find("port") {
            let after_port = &line[idx + 4..];
            let port_str: String = after_port
                .trim()
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            return port_str.parse().ok();
        }
    }

    // Pattern: http://localhost:3001 or http://0.0.0.0:3001
    if line_lower.contains("localhost:")
        || line_lower.contains("0.0.0.0:")
        || line_lower.contains("127.0.0.1:")
    {
        if let Some(idx) = line.rfind(':') {
            let after_colon = &line[idx + 1..];
            let port_str: String = after_colon
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            return port_str.parse().ok();
        }
    }

    None
}

/// Spawn a thread to read and log stderr
fn spawn_log_reader(reader: std::process::ChildStderr) {
    std::thread::spawn(move || {
        let buf_reader = BufReader::new(reader);
        for line in buf_reader.lines().map_while(Result::ok) {
            log::warn!("[backend-stderr] {}", line);
        }
    });
}

/// Wait for the backend health check to pass
fn wait_for_health(port: u16, timeout: Duration) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{}/health", port);
    let start = std::time::Instant::now();
    let retry_interval = Duration::from_millis(500);

    log::info!("Waiting for backend health check at {}", url);

    while start.elapsed() < timeout {
        match ureq_health_check(&url) {
            Ok(true) => return Ok(()),
            Ok(false) => {
                log::debug!("Health check returned non-200");
            }
            Err(e) => {
                log::debug!("Health check failed: {}", e);
            }
        }

        std::thread::sleep(retry_interval);
    }

    Err("Backend health check timeout".to_string())
}

/// Simple HTTP GET health check (no external dependencies)
fn ureq_health_check(url: &str) -> Result<bool, String> {
    use std::io::Read;
    use std::net::TcpStream;

    // Parse URL to get host and port
    let url = url.strip_prefix("http://").unwrap_or(url);
    let (host_port, path) = url.split_once('/').unwrap_or((url, ""));

    // Connect and send GET request
    let mut stream = TcpStream::connect(host_port).map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;

    let request = format!(
        "GET /{} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
        path, host_port
    );

    std::io::Write::write_all(&mut stream, request.as_bytes()).map_err(|e| e.to_string())?;

    // Read response
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|e| e.to_string())?;

    // Check for 200 OK
    Ok(response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200"))
}

/// Stop the backend process gracefully
pub fn stop_backend<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    // Best-effort: remove the discovery file so downstream consumers can
    // distinguish "app running" from "app not running". Do this before the
    // state lock so a stuck lock cannot keep a stale file around.
    if let Ok(app_data_dir_raw) = app.path().app_data_dir() {
        let app_data_dir = dunce::simplified(&app_data_dir_raw).to_path_buf();
        crate::discovery::remove(&app_data_dir);
    }

    let state: tauri::State<BackendStateWrapper> = app.state();
    let mut backend = state
        .lock()
        .map_err(|e| format!("Failed to lock backend state: {}", e))?;

    if let Some(mut child) = backend.process.take() {
        log::info!("Stopping backend process...");

        // Try graceful shutdown first (SIGTERM on Unix)
        #[cfg(unix)]
        {
            unsafe {
                libc::kill(child.id() as i32, libc::SIGTERM);
            }
        }

        #[cfg(windows)]
        {
            // On Windows, Node.js doesn't respond to WM_CLOSE (polite taskkill).
            // Use /F to force-terminate immediately; the backend has no critical
            // state that requires graceful shutdown.
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            let _ = Command::new("taskkill")
                .args(["/F", "/T", "/PID", &child.id().to_string()])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
        }

        // Wait briefly for the process to exit (up to 2s)
        let timeout = Duration::from_secs(2);
        let start = std::time::Instant::now();

        while start.elapsed() < timeout {
            match child.try_wait() {
                Ok(Some(_)) => {
                    log::info!("Backend stopped");
                    backend.ready = false;
                    backend.port = None;
                    return Ok(());
                }
                Ok(None) => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(e) => {
                    log::warn!("Error checking process status: {}", e);
                    break;
                }
            }
        }

        // Ensure kill if taskkill didn't work
        let _ = child.kill();
        let _ = child.try_wait();
    }

    backend.ready = false;
    backend.port = None;
    backend.last_error = None;

    Ok(())
}

/// IPC command: Get the backend port number
#[tauri::command]
pub fn get_backend_port<R: Runtime>(app: AppHandle<R>) -> Result<Option<u16>, String> {
    let state: tauri::State<BackendStateWrapper> = app.state();
    let backend = state
        .lock()
        .map_err(|e| format!("Failed to lock backend state: {}", e))?;
    log::debug!("IPC get_backend_port -> {:?}", backend.port);
    Ok(backend.port)
}

/// IPC command: Get backend health status
#[tauri::command]
pub fn backend_health<R: Runtime>(app: AppHandle<R>) -> Result<BackendStatus, String> {
    let state: tauri::State<BackendStateWrapper> = app.state();
    let backend = state
        .lock()
        .map_err(|e| format!("Failed to lock backend state: {}", e))?;

    log::debug!(
        "IPC backend_health -> running={}, ready={}, port={:?}, last_error={:?}",
        backend.process.is_some(),
        backend.ready,
        backend.port,
        backend.last_error
    );

    Ok(BackendStatus {
        running: backend.process.is_some(),
        ready: backend.ready,
        port: backend.port,
        last_error: backend.last_error.clone(),
    })
}

/// IPC command: Restart the backend process
///
/// Stops any running backend, then starts a fresh one.
/// Returns the new port on success.
#[tauri::command]
pub async fn restart_backend<R: Runtime>(app: AppHandle<R>) -> Result<u16, String> {
    log::info!("IPC restart_backend requested");
    let _ = stop_backend(&app);
    // Run start_backend on a blocking thread since it does I/O and waits for health
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || start_backend(&handle))
        .await
        .map_err(|e| format!("restart_backend join error: {}", e))?
}
