mod device_identity;
mod local_workstream;
mod relay_activity;

use tauri::State;

#[tauri::command]
fn platform() -> &'static str {
    std::env::consts::OS
}

#[tauri::command]
fn get_device_identity(
    state: State<'_, device_identity::DeviceIdentityStore>,
) -> Result<device_identity::DeviceIdentity, String> {
    let (keys, created) = state.keys()?;
    Ok(device_identity::public_identity(&keys, created))
}

#[tauri::command]
async fn load_channel_activity(
    state: State<'_, device_identity::DeviceIdentityStore>,
    relay_url: String,
    channel_id: String,
    author_pubkeys: Vec<String>,
    since: Option<u64>,
    limit: Option<u32>,
) -> Result<relay_activity::RelayActivityPage, String> {
    let (keys, _) = state.keys()?;
    relay_activity::load_channel_activity(
        &keys,
        &relay_url,
        &channel_id,
        &author_pubkeys,
        since,
        limit,
    )
    .await
}

#[tauri::command]
fn load_local_workstream(
    channel_id: String,
    agent_pubkey: String,
    agent_name: String,
) -> Result<local_workstream::RuntimeWorkstreamPage, String> {
    local_workstream::load_local_workstream(&channel_id, &agent_pubkey, &agent_name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(device_identity::DeviceIdentityStore::default())
        .invoke_handler(tauri::generate_handler![
            platform,
            get_device_identity,
            load_channel_activity,
            load_local_workstream
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
