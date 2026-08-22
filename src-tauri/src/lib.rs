mod channel_directory;
mod device_identity;
mod local_workstream;
mod relay_activity;
mod remote_workstream;
mod workspace_profile;

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

#[tauri::command]
fn load_fleet_workstreams() -> Result<remote_workstream::RemoteFleetDocument, String> {
    remote_workstream::load_fleet_workstreams()
}

#[tauri::command]
fn load_workspace_state() -> Result<workspace_profile::WorkspaceState, String> {
    workspace_profile::load_state()
}

#[tauri::command]
async fn list_relay_channels(
    state: State<'_, device_identity::DeviceIdentityStore>,
    relay_url: String,
) -> Result<Vec<channel_directory::ChannelSummary>, String> {
    let (keys, _) = state.keys()?;
    channel_directory::list_channels(&keys, &relay_url).await
}

#[tauri::command]
async fn discover_channel_directory(
    state: State<'_, device_identity::DeviceIdentityStore>,
    relay_url: String,
    channel_id: String,
) -> Result<channel_directory::ChannelDirectory, String> {
    let (keys, _) = state.keys()?;
    channel_directory::discover_channel(&keys, &relay_url, &channel_id).await
}

#[tauri::command]
fn create_workspace_profile(
    relay_url: String,
    workspace: String,
    viewer_name: String,
    channel_id: String,
    channel_name: String,
    channel_description: String,
) -> Result<workspace_profile::WorkspaceState, String> {
    workspace_profile::create_initial_profile(
        &relay_url,
        &workspace,
        &viewer_name,
        workspace_profile::ChannelConfig {
            id: channel_id,
            name: channel_name,
            description: channel_description,
            authors: Vec::new(),
        },
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(device_identity::DeviceIdentityStore::default())
        .invoke_handler(tauri::generate_handler![
            platform,
            get_device_identity,
            load_channel_activity,
            load_local_workstream,
            load_fleet_workstreams,
            load_workspace_state,
            list_relay_channels,
            discover_channel_directory,
            create_workspace_profile
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
