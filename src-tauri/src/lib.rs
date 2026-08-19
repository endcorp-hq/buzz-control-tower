#[tauri::command]
fn platform() -> &'static str {
    std::env::consts::OS
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![platform])
        .run(tauri::generate_context!())
        .expect("error while running Buzz Control Tower");
}

#[cfg(test)]
mod tests {
    #[test]
    fn platform_is_supported_desktop_target() {
        assert!(matches!(std::env::consts::OS, "macos" | "windows" | "linux"));
    }
}
