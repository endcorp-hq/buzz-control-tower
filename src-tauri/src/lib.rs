mod channel_directory;
mod channel_telemetry;
mod device_identity;
mod local_workstream;
mod observer_stream;
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
fn import_device_identity(
    state: State<'_, device_identity::DeviceIdentityStore>,
    secret: String,
) -> Result<device_identity::DeviceIdentity, String> {
    let secret = zeroize::Zeroizing::new(secret);
    let keys = state.import(secret.as_str())?;
    Ok(device_identity::public_identity(&keys, false))
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
async fn load_channel_telemetry(
    state: State<'_, device_identity::DeviceIdentityStore>,
    relay_url: String,
    channel_id: String,
    author_pubkeys: Vec<String>,
) -> Result<channel_telemetry::RelayTelemetryPage, String> {
    let (keys, _) = state.keys()?;
    channel_telemetry::load_channel_telemetry(&keys, &relay_url, &channel_id, &author_pubkeys).await
}

#[tauri::command]
fn start_observer_stream(
    identity: State<'_, device_identity::DeviceIdentityStore>,
    streams: State<'_, observer_stream::ObserverStreamStore>,
    relay_url: String,
    channels: Vec<String>,
) -> Result<(), String> {
    let (keys, _) = identity.keys()?;
    streams.ensure_started(keys, relay_url, channels)
}

#[tauri::command]
fn load_observer_streams(
    streams: State<'_, observer_stream::ObserverStreamStore>,
) -> Result<observer_stream::ObserverStreamsPage, String> {
    streams.snapshot()
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
        .manage(observer_stream::ObserverStreamStore::default())
        .invoke_handler(tauri::generate_handler![
            platform,
            get_device_identity,
            import_device_identity,
            load_channel_activity,
            start_observer_stream,
            load_observer_streams,
            load_channel_telemetry,
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
