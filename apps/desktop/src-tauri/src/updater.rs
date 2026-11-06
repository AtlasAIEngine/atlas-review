//! Auto-updater module for AtlasEngine Desktop
//!
//! Provides Tauri commands for checking and installing updates.
//! Emits events for download progress that the frontend can listen to.

use serde::Serialize;
use tauri::{Emitter, Runtime};

/// Information about an available update
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub notes: Option<String>,
    pub date: Option<String>,
    pub current_version: String,
}

/// Progress event emitted during update download
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub downloaded: usize,
    pub total: Option<u64>,
    pub percent: Option<f32>,
}

/// Check for available updates
///
/// Returns Some(UpdateInfo) if an update is available, None otherwise.
#[tauri::command]
pub async fn check_for_update<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Option<UpdateInfo>, String> {
    use tauri_plugin_updater::UpdaterExt;

    let current_version = app.package_info().version.to_string();
    let updater = app.updater().map_err(|e| e.to_string())?;

    log::info!(
        "Checking for updates (current version: {})",
        current_version
    );

    match updater.check().await {
        Ok(Some(update)) => {
            log::info!(
                "Update available: {} -> {}",
                current_version,
                update.version
            );
            Ok(Some(UpdateInfo {
                version: update.version.clone(),
                notes: update.body.clone(),
                date: update.date.map(|d| d.to_string()),
                current_version,
            }))
        }
        Ok(None) => {
            log::info!("No update available");
            Ok(None)
        }
        Err(e) => {
            log::error!("Failed to check for updates: {}", e);
            Err(e.to_string())
        }
    }
}

/// Download and install an available update
///
/// Emits "update-download-progress" events during download.
/// Restarts the application after successful installation.
#[tauri::command]
pub async fn download_and_install<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;

    let updater = app.updater().map_err(|e| e.to_string())?;

    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No update available".to_string())?;

    log::info!("Starting download of version {}", update.version);

    // Clone app handle for use in closures
    let app_handle = app.clone();

    // Download the update with progress reporting
    let mut downloaded: usize = 0;
    let bytes = update
        .download(
            |chunk_length, content_length| {
                downloaded += chunk_length;
                let percent =
                    content_length.map(|total| (downloaded as f32 / total as f32) * 100.0);

                let progress = DownloadProgress {
                    downloaded,
                    total: content_length,
                    percent,
                };

                // Emit progress event to frontend
                if let Err(e) = app_handle.emit("update-download-progress", &progress) {
                    log::warn!("Failed to emit progress event: {}", e);
                }

                log::debug!(
                    "Download progress: {} / {:?} bytes ({:.1}%)",
                    downloaded,
                    content_length,
                    percent.unwrap_or(0.0)
                );
            },
            || {
                log::info!("Download complete");
            },
        )
        .await
        .map_err(|e| {
            log::error!("Download failed: {}", e);
            e.to_string()
        })?;

    log::info!("Installing update...");

    // Stop the backend process BEFORE launching the installer.
    // On Windows, the NSIS installer needs to overwrite files (e.g.
    // better_sqlite3.node) that are locked by the running Node.js process.
    // Without this, the installer shows "Error opening file for writing".
    let backend_stopped = if let Err(e) = crate::backend::stop_backend(&app) {
        log::warn!(
            "Failed to stop backend before update (continuing anyway): {}",
            e
        );
        false
    } else {
        // Give the Node.js process time to fully exit and release file handles
        // (flush buffers, close SQLite connections, etc.)
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        true
    };

    // Install the update. If the installer fails after we stopped the backend,
    // bring the sidecar back so the current app session remains usable.
    if let Err(e) = update.install(bytes) {
        log::error!("Installation failed: {}", e);

        if backend_stopped {
            match crate::backend::start_backend(&app) {
                Ok(port) => {
                    log::info!(
                        "Restarted backend on port {} after failed update installation",
                        port
                    );
                }
                Err(restart_error) => {
                    log::error!(
                        "Failed to restart backend after update install error: {}",
                        restart_error
                    );
                    return Err(format!(
                        "{} (backend restart after failed install also failed: {})",
                        e, restart_error
                    ));
                }
            }
        }

        return Err(e.to_string());
    }

    log::info!("Update installed, restarting application");

    // Restart the application
    app.restart();
}
