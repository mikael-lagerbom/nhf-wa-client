use std::fs;
use std::fs::File;
use std::path::Path;
use std::path::PathBuf;
use zip::ZipArchive;
use zip::write::FileOptions;
use serde::{Deserialize, Serialize};
use std::io::Write;
use tauri::{Emitter, Manager, WindowEvent};
use tauri::tray::{TrayIconBuilder, TrayIconEvent, MouseButton, MouseButtonState};
use tauri::menu::{Menu, MenuItem};
use std::time::{SystemTime, UNIX_EPOCH};
use std::sync::Mutex;

#[cfg(target_os = "windows")]
use winreg::enums::*;
#[cfg(target_os = "windows")]
use winreg::RegKey;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn extract_zip(file_path: String, destination: String) -> Result<(), String> {
    let destination_path = Path::new(&destination);

    if !destination_path.exists() {
        return Err("Addon Folder does not exist".to_string());
    }

    // Check if the file exists and is readable
    if !Path::new(&file_path).exists() {
        return Err("ZIP file does not exist".to_string());
    }

    // Check file size to ensure it's not empty
    let metadata =
        fs::metadata(&file_path).map_err(|e| format!("Failed to read file metadata: {}", e))?;
    if metadata.len() == 0 {
        return Err("ZIP file is empty".to_string());
    }

    let file = File::open(&file_path).map_err(|e| format!("Failed to open ZIP file: {}", e))?;

    // Try to create the ZIP archive with better error handling
    let mut archive = match ZipArchive::new(file) {
        Ok(archive) => {
            if archive.len() == 0 {
                return Err("ZIP file contains no entries".to_string());
            }
            archive
        }
        Err(zip::result::ZipError::InvalidArchive(msg)) => {
            return Err(format!("Invalid ZIP file: {}", msg));
        }
        Err(zip::result::ZipError::Io(io_err)) => {
            return Err(format!("I/O error reading ZIP file: {}", io_err));
        }
        Err(zip::result::ZipError::UnsupportedArchive(msg)) => {
            return Err(format!("Unsupported ZIP format: {}", msg));
        }
        Err(e) => {
            return Err(format!("ZIP file error: {}", e));
        }
    };

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read file {} from ZIP: {}", i, e))?;
        let Some(safe_name) = file.enclosed_name() else {
            return Err(format!(
                "ZIP entry {} has an unsafe path and was rejected",
                i
            ));
        };
        let out_path = destination_path.join(safe_name);

        if file.is_dir() {
            std::fs::create_dir_all(&out_path)
                .map_err(|e| format!("Failed to create directory {}: {}", out_path.display(), e))?;
        } else {
            if let Some(p) = out_path.parent() {
                std::fs::create_dir_all(p).map_err(|e| {
                    format!("Failed to create parent directory {}: {}", p.display(), e)
                })?;
            }
            let mut outfile = File::create(&out_path)
                .map_err(|e| format!("Failed to create file {}: {}", out_path.display(), e))?;
            std::io::copy(&mut file, &mut outfile)
                .map_err(|e| format!("Failed to extract file {}: {}", out_path.display(), e))?;
        }
    }
    Ok(())
}

#[tauri::command]
fn validate_zip(file_path: String) -> Result<bool, String> {
    let path = Path::new(&file_path);

    if !path.exists() {
        return Err("ZIP file does not exist".to_string());
    }

    if !path.is_file() {
        return Err("Path is not a file".to_string());
    }

    let file = File::open(path).map_err(|e| format!("Failed to open file: {}", e))?;

    match ZipArchive::new(file) {
        Ok(_) => Ok(true),
        Err(zip::result::ZipError::InvalidArchive(msg)) => {
            Err(format!("Invalid ZIP file: {}", msg))
        }
        Err(zip::result::ZipError::Io(io_err)) => {
            Err(format!("I/O error reading file: {}", io_err))
        }
        Err(zip::result::ZipError::UnsupportedArchive(msg)) => {
            Err(format!("Unsupported ZIP format: {}", msg))
        }
        Err(e) => Err(format!("ZIP validation error: {}", e)),
    }
}

#[tauri::command]
fn get_zip_info(file_path: String) -> Result<String, String> {
    let path = Path::new(&file_path);

    if !path.exists() {
        return Err("File does not exist".to_string());
    }

    if !path.is_file() {
        return Err("Path is not a file".to_string());
    }

    let metadata = fs::metadata(path).map_err(|e| format!("Failed to read metadata: {}", e))?;
    let file_size = metadata.len();

    if file_size == 0 {
        return Err("File is empty (0 bytes)".to_string());
    }

    let file = File::open(path).map_err(|e| format!("Failed to open file: {}", e))?;

    match ZipArchive::new(file) {
        Ok(archive) => {
            let entry_count = archive.len();
            if entry_count == 0 {
                return Err("ZIP file contains no entries".to_string());
            }
            Ok(format!("Valid ZIP file: {} entries, {} bytes", entry_count, file_size))
        }
        Err(zip::result::ZipError::InvalidArchive(msg)) => {
            Err(format!("Invalid ZIP file: {}. This usually means the file is corrupted or incomplete. Try downloading it again.", msg))
        }
        Err(zip::result::ZipError::Io(io_err)) => {
            Err(format!("I/O error reading file: {}. Check if the file is accessible and not locked by another process.", io_err))
        }
        Err(zip::result::ZipError::UnsupportedArchive(msg)) => {
            Err(format!("Unsupported ZIP format: {}. The file might be using an unsupported compression method.", msg))
        }
        Err(e) => {
            Err(format!("ZIP error: {}. This could indicate file corruption.", e))
        }
    }
}

#[tauri::command]
fn read_file(file_path: String) -> Result<String, String> {
    let path = PathBuf::from(file_path);
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(file_path: String, contents: String) -> Result<(), String> {
    let path = PathBuf::from(&file_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_binary_file(file_path: String, contents: Vec<u8>) -> Result<(), String> {
    let path = PathBuf::from(&file_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
fn file_exists(file_path: String) -> bool {
    PathBuf::from(&file_path).is_file()
}

#[tauri::command]
fn clear_directory(file_path: String) -> Result<(), String> {
    let path = PathBuf::from(&file_path);
    if path.exists() {
        fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[derive(Serialize, Deserialize)]
struct BackupProgress {
    progress: u32,
    status: String,
    completed: bool,
    error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct BackupProgressEvent {
    progress: u32,
    status: String,
    current_file: Option<String>,
    files_processed: usize,
    total_files: usize,
}

fn cleanup_old_backups(backup_dir: &std::path::Path, app_handle: &tauri::AppHandle) -> Result<usize, String> {
    let mut deleted_count = 0;
    let two_weeks_ago = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("Failed to get current time: {}", e))?
        .as_secs() - (14 * 24 * 60 * 60); // 14 days in seconds

    // Emit cleanup start progress
    let _ = app_handle.emit("backup-progress", BackupProgressEvent {
        progress: 1,
        status: "Cleaning up old backups...".to_string(),
        current_file: None,
        files_processed: 0,
        total_files: 0,
    });

    if !backup_dir.exists() {
        return Ok(0);
    }

    let entries = fs::read_dir(backup_dir)
        .map_err(|e| format!("Failed to read backup directory: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let path = entry.path();
        
        if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("zip") {
            // Check if file is a backup file (starts with "WeakAuras_Backup_")
            if let Some(filename) = path.file_name().and_then(|s| s.to_str()) {
                if filename.starts_with("WeakAuras_Backup_") {
                    // Get file metadata to check creation time
                    let metadata = fs::metadata(&path)
                        .map_err(|e| format!("Failed to get file metadata for {:?}: {}", path, e))?;
                    
                    let created_time = metadata.created()
                        .or_else(|_| metadata.modified()) // Fallback to modified time if created time not available
                        .map_err(|e| format!("Failed to get file time for {:?}: {}", path, e))?
                        .duration_since(UNIX_EPOCH)
                        .map_err(|e| format!("Failed to convert file time for {:?}: {}", path, e))?
                        .as_secs();

                    if created_time < two_weeks_ago {
                        // Delete old backup file
                        fs::remove_file(&path)
                            .map_err(|e| format!("Failed to delete old backup {:?}: {}", path, e))?;
                        
                        deleted_count += 1;
                        
                        // Emit cleanup progress
                        let _ = app_handle.emit("backup-progress", BackupProgressEvent {
                            progress: 2,
                            status: format!("Deleted old backup: {}", filename),
                            current_file: Some(filename.to_string()),
                            files_processed: deleted_count,
                            total_files: 0,
                        });
                    }
                }
            }
        }
    }

    if deleted_count > 0 {
        let _ = app_handle.emit("backup-progress", BackupProgressEvent {
            progress: 3,
            status: format!("Cleaned up {} old backup(s)", deleted_count),
            current_file: None,
            files_processed: deleted_count,
            total_files: 0,
        });
    }

    Ok(deleted_count)
}


fn backup_directory_recursive_with_progress(
    dir_path: &std::path::Path,
    zip: &mut zip::ZipWriter<std::fs::File>,
    options: &zip::write::FileOptions<()>,
    account_id: &str,
    app_handle: &tauri::AppHandle,
    mut files_processed: usize,
    total_files: usize,
) -> Result<(usize, usize, usize), String> {
    let mut file_count = 0;
    
    fn walk_dir_with_progress(
        dir_path: &std::path::Path,
        zip: &mut zip::ZipWriter<std::fs::File>,
        options: &zip::write::FileOptions<()>,
        account_id: &str,
        base_path: &std::path::Path,
        file_count: &mut usize,
        files_processed: &mut usize,
        total_files: usize,
        app_handle: &tauri::AppHandle,
    ) -> Result<(), String> {
        for entry in std::fs::read_dir(dir_path)
            .map_err(|e| format!("Failed to read directory {:?}: {}", dir_path, e))? {
            let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
            let path = entry.path();
            
            if path.is_dir() {
                walk_dir_with_progress(&path, zip, options, account_id, base_path, file_count, files_processed, total_files, app_handle)?;
            } else if path.is_file() {
                // Calculate relative path from the account folder
                let relative_path = path.strip_prefix(base_path)
                    .map_err(|e| format!("Failed to calculate relative path: {}", e))?;
                
                // Create zip entry path: account_id/relative_path
                let zip_entry_name = format!("{}/{}", account_id, relative_path.to_string_lossy().replace('\\', "/"));
                
                // Emit progress update every 10 files or for important files
                if *files_processed % 10 == 0 || relative_path.to_string_lossy().contains("WeakAuras") {
                    // For full backups, use a different progress approach
                    let progress_percent = if total_files > 0 && total_files > *files_processed {
                        // We have a known total and haven't exceeded it
                        8 + ((*files_processed as f32 / total_files as f32) * 80.0) as u32
                    } else {
                        // Dynamic progress: show progress based on files processed
                        // Cap at 85% to leave room for finalization
                        let dynamic_progress = 8 + (*files_processed / 20) as u32;
                        if dynamic_progress > 85 { 85 } else { dynamic_progress }
                    };
                    
                    let _ = app_handle.emit("backup-progress", BackupProgressEvent {
                        progress: progress_percent,
                        status: format!("Backing up: {}", zip_entry_name),
                        current_file: Some(zip_entry_name.clone()),
                        files_processed: *files_processed,
                        total_files: 0, // Don't show file count to user
                    });
                }
                
                // Read file content
                let file_content = std::fs::read(&path)
                    .map_err(|e| format!("Failed to read file {:?}: {}", path, e))?;
                
                // Add to zip
                zip.start_file(&zip_entry_name, *options)
                    .map_err(|e| format!("Failed to add file to zip: {}", e))?;
                
                zip.write_all(&file_content)
                    .map_err(|e| format!("Failed to write file content to zip: {}", e))?;
                
                *file_count += 1;
                *files_processed += 1;
            }
        }
        Ok(())
    }
    
    walk_dir_with_progress(dir_path, zip, options, account_id, dir_path, &mut file_count, &mut files_processed, total_files, app_handle)?;
    Ok((file_count, files_processed, files_processed))
}


#[tauri::command]
async fn backup_weakauras(
    app_handle: tauri::AppHandle,
    wow_folder: String, 
    backup_all_data: bool
) -> Result<BackupProgress, String> {
    let wtf_path = Path::new(&wow_folder).join("WTF").join("Account");
    
    if !wtf_path.exists() {
        return Ok(BackupProgress {
            progress: 0,
            status: "WTF/Account folder not found".to_string(),
            completed: false,
            error: Some("WTF/Account folder not found".to_string()),
        });
    }

    // Emit initial progress
    let _ = app_handle.emit("backup-progress", BackupProgressEvent {
        progress: 0,
        status: "Scanning account folders...".to_string(),
        current_file: None,
        files_processed: 0,
        total_files: 0,
    });

    // Find all account folders
    let account_entries = fs::read_dir(&wtf_path)
        .map_err(|e| format!("Failed to read WTF/Account directory: {}", e))?;

    let mut account_folders = Vec::new();
    for entry in account_entries {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        if entry.file_type().map_err(|e| format!("Failed to get file type: {}", e))?.is_dir() {
            if let Some(name) = entry.file_name().to_str() {
                if !name.starts_with('.') {
                    account_folders.push(name.to_string());
                }
            }
        }
    }

    if account_folders.is_empty() {
        return Ok(BackupProgress {
            progress: 0,
            status: "No account folders found".to_string(),
            completed: false,
            error: Some("No account folders found in WTF/Account".to_string()),
        });
    }

    // For progress tracking, we'll use a dynamic approach
    // Instead of pre-counting, we'll discover files as we process them
    let mut estimated_total = 0;
    if !backup_all_data {
        // For WeakAuras.lua only, we can accurately count these
        for account_id in &account_folders {
            let weakauras_path = wtf_path.join(account_id).join("SavedVariables").join("WeakAuras.lua");
            if weakauras_path.exists() {
                estimated_total += 1;
            }
        }
    }
    // For full backup, we'll start with 0 and discover as we go

    // Emit initial progress
    let _ = app_handle.emit("backup-progress", BackupProgressEvent {
        progress: 5,
        status: "Starting backup...".to_string(),
        current_file: None,
        files_processed: 0,
        total_files: 0,
    });

    // Create backup directory
    let backup_dir = Path::new(&wow_folder).join("NHF-Backup");
    if !backup_dir.exists() {
        fs::create_dir_all(&backup_dir)
            .map_err(|e| format!("Failed to create backup directory: {}", e))?;
    }

    // Clean up old backups (older than 2 weeks) before creating new one
    let _deleted_count = cleanup_old_backups(&backup_dir, &app_handle)?;

    let timestamp = chrono::Utc::now().format("%Y-%m-%dT%H-%M-%S-%3fZ").to_string();
    let zip_filename = format!("WeakAuras_Backup_{}.zip", timestamp);
    let zip_file_path = backup_dir.join(&zip_filename);

    // Create the zip file
    let zip_file = File::create(&zip_file_path)
        .map_err(|e| format!("Failed to create backup zip file: {}", e))?;
    
    let mut zip = zip::ZipWriter::new(zip_file);
    let options: FileOptions<()> = FileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let mut backed_up_count = 0;
    let mut files_processed = 0;
    let mut actual_total = estimated_total; // Will be updated as we discover more files

    // Emit zip creation progress
    let _ = app_handle.emit("backup-progress", BackupProgressEvent {
        progress: 8,
        status: "Creating backup archive...".to_string(),
        current_file: None,
        files_processed: 0,
        total_files: 0,
    });

    for account_id in &account_folders {
        if backup_all_data {
            // Backup entire account folder with progress
            let account_path = wtf_path.join(account_id);
            if account_path.exists() {
                let (count, processed, discovered_total) = backup_directory_recursive_with_progress(
                    &account_path, 
                    &mut zip, 
                    &options, 
                    account_id,
                    &app_handle,
                    files_processed,
                    actual_total
                )?;
                backed_up_count += count;
                files_processed += processed;
                // Update total if we discovered more files than estimated
                if discovered_total > actual_total {
                    actual_total = discovered_total;
                }
            }
        } else {
            // Backup only WeakAuras.lua
            let saved_vars_path = wtf_path.join(account_id).join("SavedVariables");
            let weakauras_path = saved_vars_path.join("WeakAuras.lua");

            if weakauras_path.exists() {
                // Emit current file progress
                let _ = app_handle.emit("backup-progress", BackupProgressEvent {
                    progress: 8 + ((files_processed as f32 / actual_total as f32) * 80.0) as u32,
                    status: format!("Backing up WeakAuras.lua for account {}", account_id),
                    current_file: Some(format!("{}/WeakAuras.lua", account_id)),
                    files_processed,
                    total_files: 0, // Don't show file count to user
                });

                // Read the WeakAuras.lua file content
                let file_content = fs::read_to_string(&weakauras_path)
                    .map_err(|e| format!("Failed to read WeakAuras.lua for account {}: {}", account_id, e))?;

                // Add file to zip in account-specific folder, preserving original filename
                let zip_entry_name = format!("{}/WeakAuras.lua", account_id);
                zip.start_file(&zip_entry_name, options)
                    .map_err(|e| format!("Failed to add file to zip: {}", e))?;
                
                zip.write_all(file_content.as_bytes())
                    .map_err(|e| format!("Failed to write file content to zip: {}", e))?;
                
                backed_up_count += 1;
                files_processed += 1;
            }
        }
    }

    // Emit finalization progress
    let _ = app_handle.emit("backup-progress", BackupProgressEvent {
        progress: 95,
        status: "Finalizing backup archive...".to_string(),
        current_file: None,
        files_processed,
        total_files: 0,
    });

    // Finish the zip file
    zip.finish()
        .map_err(|e| format!("Failed to finalize zip file: {}", e))?;

    // Emit completion
    let _ = app_handle.emit("backup-progress", BackupProgressEvent {
        progress: 100,
        status: format!("Backup completed! {} files backed up to {}.", backed_up_count, zip_filename),
        current_file: None,
        files_processed,
        total_files: 0,
    });

    Ok(BackupProgress {
        progress: 100,
        status: format!("Backup completed! {} files backed up to {}.", backed_up_count, zip_filename),
        completed: true,
        error: None,
    })
}

// Global state for minimize to tray setting
struct MinimizeToTrayState {
    enabled: bool,
}

#[tauri::command]
async fn set_minimize_to_tray(
    state: tauri::State<'_, Mutex<MinimizeToTrayState>>,
    enabled: bool,
) -> Result<(), String> {
    let mut state = state.lock().map_err(|e| e.to_string())?;
    state.enabled = enabled;
    Ok(())
}

#[tauri::command]
async fn get_minimize_to_tray(
    state: tauri::State<'_, Mutex<MinimizeToTrayState>>,
) -> Result<bool, String> {
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(state.enabled)
}

#[tauri::command]
async fn show_window(window: tauri::Window) -> Result<(), String> {
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

// Startup management functions
#[tauri::command]
async fn set_start_on_startup(_app_handle: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let run_key = hkcu.open_subkey_with_flags("Software\\Microsoft\\Windows\\CurrentVersion\\Run", KEY_WRITE)
            .map_err(|e| format!("Failed to open registry key: {}", e))?;
        
        let app_name = "NHF Addon Manager";
        let exe_path = std::env::current_exe()
            .map_err(|e| format!("Failed to get app executable path: {}", e))?;
        
        if enabled {
            // Add to startup with minimized argument
            let startup_command = format!("{} --minimized", exe_path.to_string_lossy());
            run_key.set_value(app_name, &startup_command)
                .map_err(|e| format!("Failed to set registry value: {}", e))?;
        } else {
            // Remove from startup
            match run_key.delete_value(app_name) {
                Ok(_) => {},
                Err(e) => {
                    // Check if it's a file not found error (which is fine)
                    if e.to_string().contains("file not found") || e.to_string().contains("not found") {
                        // Key doesn't exist, which is fine
                    } else {
                        return Err(format!("Failed to delete registry value: {}", e));
                    }
                }
            }
        }
    }
    
    #[cfg(not(target_os = "windows"))]
    {
        return Err("Startup management is only supported on Windows".to_string());
    }
    
    Ok(())
}

#[tauri::command]
async fn get_start_on_startup() -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let run_key = hkcu.open_subkey_with_flags("Software\\Microsoft\\Windows\\CurrentVersion\\Run", KEY_READ)
            .map_err(|e| format!("Failed to open registry key: {}", e))?;
        
        let app_name = "NHF Addon Manager";
        match run_key.get_value::<String, _>(app_name) {
            Ok(_) => {
                // App is set to start on startup (regardless of minimized flag)
                Ok(true)
            },
            Err(e) => {
                // Check if it's a file not found error
                if e.to_string().contains("file not found") || e.to_string().contains("not found") {
                    Ok(false)
                } else {
                    Err(format!("Failed to read registry value: {}", e))
                }
            }
        }
    }
    
    #[cfg(not(target_os = "windows"))]
    {
        Ok(false)
    }
}




#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_upload::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init());

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .manage(Mutex::new(MinimizeToTrayState { enabled: false }))
        .setup(|app| {
            // Check if app should start minimized
            let args: Vec<String> = std::env::args().collect();
            let start_minimized = args.iter().any(|arg| arg == "--minimized");
            
            // Create tray menu
            let show_item = MenuItem::with_id(app, "show", "Show NHF Addon Manager", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            // Create system tray
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| {
                    match event.id.as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.unminimize();
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    match event {
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } => {
                            // Show and focus the main window when tray is clicked
                            let app = tray.app_handle();
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.unminimize();
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            if let Some(window) = app.get_webview_window("main") {
                // Windows can still apply a square drop shadow unless disabled at runtime.
                let _ = window.set_shadow(false);
            }

            // Hide window if started with --minimized flag
            if start_minimized {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            extract_zip,
            read_file,
            write_file,
            write_binary_file,
            file_exists,
            clear_directory,
            validate_zip,
            get_zip_info,
            backup_weakauras,
            set_minimize_to_tray,
            get_minimize_to_tray,
            show_window,
            set_start_on_startup,
            get_start_on_startup
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app_handle = window.app_handle();
                
                // Check if minimize to tray is enabled
                if let Ok(minimize_state) = app_handle.state::<Mutex<MinimizeToTrayState>>().lock() {
                    if minimize_state.enabled {
                        // Prevent default close behavior
                        api.prevent_close();
                        
                        // Hide the window instead of closing
                        let _ = window.hide();
                        return;
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
