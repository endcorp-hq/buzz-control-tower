mod device_identity;
mod observer;

#[tauri::command]
fn platform() -> &'static str {
    std::env::consts::OS
}

#[tauri::command]
fn get_device_identity() -> Result<device_identity::DeviceIdentity, String> {
    let (keys, created) = device_identity::load_or_create_device_keys()?;
    Ok(device_identity::public_identity(&keys, created))
}

#[tauri::command]
fn decrypt_observer_frame(
    event_json: String,
    expected_agent: Option<String>,
    channel_id: Option<String>,
) -> Result<observer::ValidatedObserverFrame, String> {
    let (keys, _) = device_identity::load_or_create_device_keys()?;
    observer::validate_and_decrypt(
        &keys,
        &event_json,
        expected_agent.as_deref(),
        channel_id.as_deref(),
    )
    .map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            platform,
            get_device_identity,
            decrypt_observer_frame
        ])
        .run(tauri::generate_context!())
        .expect("error while running Buzz Control Tower");
}

#[cfg(test)]
mod tests {
    #[test]
    fn platform_is_supported_desktop_target() {
        assert!(matches!(
            std::env::consts::OS,
            "macos" | "windows" | "linux"
        ));
    }
}
