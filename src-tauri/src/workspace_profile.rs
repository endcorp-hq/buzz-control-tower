//! Runtime workspace profile: the single source of relay, channel, author,
//! collector, and local-runtime bindings.
//!
//! The profile is a user-owned JSON file edited by the deterministic `tower`
//! CLI (`scripts/tower.mjs`) or any operator tooling. Native code loads and
//! validates the profile from disk and hands the webview a bounded,
//! already-validated document. Nothing is compiled in and no workspace is
//! joined automatically: with no profile on disk the app enters onboarding.
//!
//! The webview-reachable writes are deliberately narrow: `create_initial_profile`
//! (which refuses to run once a profile exists), and `add_channel` /
//! `remove_channel`, which only grow or shrink the observed-channel list and
//! re-run the full profile validation before persisting. Everything else —
//! retargeting the relay, collectors, pinned authors, the local runtime —
//! stays an operator/CLI action.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::relay_activity::http_query_url;

pub const PROFILE_VERSION: u32 = 1;
const MAX_PROFILE_BYTES: u64 = 256 * 1024;
const MAX_CHANNELS: usize = 8;
const MAX_AUTHORS_PER_CHANNEL: usize = 50;
const MAX_COLLECTORS: usize = 4;
const MAX_NAME: usize = 120;
const MAX_COMMAND: usize = 256;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorConfig {
    pub pubkey: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelConfig {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub authors: Vec<AuthorConfig>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollectorConfig {
    pub label: String,
    pub channel_id: String,
    pub ssh_host: String,
    pub command: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalRuntimeConfig {
    pub channel_id: String,
    pub agent_pubkey: String,
    pub agent_name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceProfile {
    pub version: u32,
    pub workspace: String,
    pub viewer_name: String,
    pub relay_url: String,
    pub channels: Vec<ChannelConfig>,
    #[serde(default)]
    pub collectors: Vec<CollectorConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_runtime: Option<LocalRuntimeConfig>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceState {
    pub path: String,
    /// `None` means no profile exists yet — the app shows onboarding.
    pub profile: Option<WorkspaceProfile>,
}

fn is_hex_pubkey(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_name(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= MAX_NAME
}

fn valid_ssh_host(value: &str) -> bool {
    let Some((user, host)) = value.split_once('@') else {
        return false;
    };
    let part_ok = |part: &str| {
        !part.is_empty()
            && !part.starts_with('-')
            && part.len() <= MAX_NAME
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    };
    part_ok(user) && part_ok(host)
}

fn valid_collector_command(value: &str) -> bool {
    value.starts_with('/')
        && value.len() <= MAX_COMMAND
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'.' | b'_' | b'-'))
}

pub fn validate(profile: &WorkspaceProfile) -> Result<(), String> {
    if profile.version != PROFILE_VERSION {
        return Err(format!(
            "workspace profile version must be {PROFILE_VERSION}"
        ));
    }
    if !valid_name(&profile.workspace) || !valid_name(&profile.viewer_name) {
        return Err("workspace and viewer names must be 1 to 120 characters".into());
    }
    http_query_url(&profile.relay_url)?;
    if profile.channels.is_empty() || profile.channels.len() > MAX_CHANNELS {
        return Err(format!("profile must list 1 to {MAX_CHANNELS} channels"));
    }
    let mut channel_ids = Vec::new();
    for channel in &profile.channels {
        Uuid::parse_str(&channel.id)
            .map_err(|_| format!("channel id is not a UUID: {}", channel.id))?;
        if channel_ids.contains(&channel.id.as_str()) {
            return Err(format!("duplicate channel id: {}", channel.id));
        }
        channel_ids.push(channel.id.as_str());
        if !valid_name(&channel.name) || channel.description.chars().count() > MAX_NAME * 2 {
            return Err(format!(
                "channel {} has an invalid name or description",
                channel.id
            ));
        }
        if channel.authors.len() > MAX_AUTHORS_PER_CHANNEL {
            return Err(format!(
                "channel {} exceeds {MAX_AUTHORS_PER_CHANNEL} authors",
                channel.id
            ));
        }
        let mut authors = Vec::new();
        for author in &channel.authors {
            if !is_hex_pubkey(&author.pubkey) {
                return Err(format!("invalid author pubkey: {}", author.pubkey));
            }
            if authors.contains(&author.pubkey.as_str()) {
                return Err(format!("duplicate author pubkey: {}", author.pubkey));
            }
            authors.push(author.pubkey.as_str());
            if author.name.as_deref().is_some_and(|name| !valid_name(name)) {
                return Err(format!("invalid author name for {}", author.pubkey));
            }
        }
    }
    if profile.collectors.len() > MAX_COLLECTORS {
        return Err(format!("profile exceeds {MAX_COLLECTORS} collectors"));
    }
    for collector in &profile.collectors {
        if !valid_name(&collector.label) {
            return Err("collector label must be 1 to 120 characters".into());
        }
        if !channel_ids.contains(&collector.channel_id.as_str()) {
            return Err(format!(
                "collector {} is bound to an unlisted channel {}",
                collector.label, collector.channel_id
            ));
        }
        if !valid_ssh_host(&collector.ssh_host) {
            return Err(format!(
                "collector {} has an invalid user@host",
                collector.label
            ));
        }
        if !valid_collector_command(&collector.command) {
            return Err(format!(
                "collector {} command must be a fixed absolute path",
                collector.label
            ));
        }
    }
    if let Some(local) = &profile.local_runtime {
        if !channel_ids.contains(&local.channel_id.as_str()) {
            return Err("local runtime is bound to an unlisted channel".into());
        }
        if !is_hex_pubkey(&local.agent_pubkey) || !valid_name(&local.agent_name) {
            return Err("local runtime has an invalid agent identity".into());
        }
    }
    Ok(())
}

pub fn profile_path() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("CONTROL_TOWER_WORKSPACE") {
        return Ok(PathBuf::from(path));
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "cannot locate the current user's home directory".to_string())?;
    Ok(home
        .join(".config")
        .join("control-tower")
        .join("workspace.json"))
}

pub fn load_state() -> Result<WorkspaceState, String> {
    let path = profile_path()?;
    let display_path = path.to_string_lossy().into_owned();
    if !path.exists() {
        return Ok(WorkspaceState {
            path: display_path,
            profile: None,
        });
    }

    let metadata = fs::metadata(&path)
        .map_err(|error| format!("cannot read the workspace profile: {error}"))?;
    if !metadata.is_file() || metadata.len() > MAX_PROFILE_BYTES {
        return Err(format!(
            "workspace profile at {display_path} failed safety checks"
        ));
    }
    let body = fs::read_to_string(&path)
        .map_err(|error| format!("cannot read the workspace profile: {error}"))?;
    let profile: WorkspaceProfile = serde_json::from_str(&body)
        .map_err(|error| format!("workspace profile at {display_path} is not valid: {error}"))?;
    validate(&profile)
        .map_err(|error| format!("workspace profile at {display_path} is not valid: {error}"))?;
    Ok(WorkspaceState {
        path: display_path,
        profile: Some(profile),
    })
}

/// First-run onboarding write: create the initial workspace profile for one
/// relay and one channel. Refuses to touch an existing profile, so this is
/// only reachable while the app is in the onboarding state — later changes
/// go through the `tower` CLI.
pub fn create_initial_profile(
    relay_url: &str,
    workspace: &str,
    viewer_name: &str,
    channel: ChannelConfig,
) -> Result<WorkspaceState, String> {
    let path = profile_path()?;
    let display_path = path.to_string_lossy().into_owned();
    if path.exists() {
        return Err(format!(
            "a workspace profile already exists at {display_path}; edit it with the tower CLI"
        ));
    }
    let profile = WorkspaceProfile {
        version: PROFILE_VERSION,
        workspace: workspace.trim().to_string(),
        viewer_name: viewer_name.trim().to_string(),
        relay_url: relay_url.trim().to_string(),
        channels: vec![channel],
        collectors: Vec::new(),
        local_runtime: None,
    };
    validate(&profile)?;
    write_profile(&path, &profile)?;
    Ok(WorkspaceState {
        path: display_path,
        profile: Some(profile),
    })
}

fn write_profile(path: &PathBuf, profile: &WorkspaceProfile) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("cannot create the workspace profile directory: {error}"))?;
    }
    let body = serde_json::to_string_pretty(profile)
        .map_err(|error| format!("cannot encode the workspace profile: {error}"))?;
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, body + "\n")
        .map_err(|error| format!("cannot write the workspace profile: {error}"))?;
    fs::rename(&temp, path)
        .map_err(|error| format!("cannot finalize the workspace profile: {error}"))?;
    Ok(())
}

/// Load the existing profile or explain why a channel edit cannot proceed.
fn load_profile_for_edit() -> Result<(PathBuf, WorkspaceProfile), String> {
    let path = profile_path()?;
    let state = load_state()?;
    let profile = state
        .profile
        .ok_or_else(|| format!("no workspace profile exists at {}", state.path))?;
    Ok((path, profile))
}

/// Append a channel to the observed-channel list. The full profile validation
/// runs before anything is persisted, so the channel cap, UUID shape, and
/// duplicate checks all apply.
pub fn add_channel(channel: ChannelConfig) -> Result<WorkspaceState, String> {
    let (path, mut profile) = load_profile_for_edit()?;
    if profile.channels.iter().any(|existing| existing.id == channel.id) {
        return Err(format!(
            "channel {} is already part of this workspace",
            channel.id
        ));
    }
    profile.channels.push(channel);
    validate(&profile)?;
    write_profile(&path, &profile)?;
    Ok(WorkspaceState {
        path: path.to_string_lossy().into_owned(),
        profile: Some(profile),
    })
}

/// Remove a channel from the observed-channel list. Refuses to orphan fleet
/// collectors or the local runtime — unbinding those stays a CLI action — and
/// refuses to remove the last channel.
pub fn remove_channel(channel_id: &str) -> Result<WorkspaceState, String> {
    let (path, mut profile) = load_profile_for_edit()?;
    if !profile.channels.iter().any(|channel| channel.id == channel_id) {
        return Err(format!("channel {channel_id} is not part of this workspace"));
    }
    if profile.channels.len() == 1 {
        return Err("cannot remove the last channel; the workspace must observe at least one".into());
    }
    if profile
        .collectors
        .iter()
        .any(|collector| collector.channel_id == channel_id)
    {
        return Err(format!(
            "channel {channel_id} has a fleet collector bound to it; unbind it with the tower CLI first"
        ));
    }
    if profile
        .local_runtime
        .as_ref()
        .is_some_and(|local| local.channel_id == channel_id)
    {
        return Err(format!(
            "channel {channel_id} is bound to the local runtime; unbind it with the tower CLI first"
        ));
    }
    profile.channels.retain(|channel| channel.id != channel_id);
    validate(&profile)?;
    write_profile(&path, &profile)?;
    Ok(WorkspaceState {
        path: path.to_string_lossy().into_owned(),
        profile: Some(profile),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // Tests that point CONTROL_TOWER_WORKSPACE at a scratch file mutate global
    // process state; serialize them so parallel test threads cannot interleave.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn sample_profile() -> WorkspaceProfile {
        WorkspaceProfile {
            version: PROFILE_VERSION,
            workspace: "example-team".into(),
            viewer_name: "Operator".into(),
            relay_url: "wss://relay.example".into(),
            channels: vec![
                ChannelConfig {
                    id: "0b7c0958-3f7f-48c8-af3f-31e549b10e31".into(),
                    name: "general".into(),
                    description: "Team channel".into(),
                    authors: vec![AuthorConfig {
                        pubkey: "19215c80f8a71880f8c5738410d041e8afb2093bde1df8b4b691f23a50cb8b13"
                            .into(),
                        name: Some("Agent".into()),
                    }],
                },
                ChannelConfig {
                    id: "1da2b83b-c1e5-44b3-8a1c-546bf665933e".into(),
                    name: "ops".into(),
                    description: String::new(),
                    authors: Vec::new(),
                },
            ],
            collectors: vec![CollectorConfig {
                label: "Fleet".into(),
                channel_id: "1da2b83b-c1e5-44b3-8a1c-546bf665933e".into(),
                ssh_host: "control-tower@host.example.ts.net".into(),
                command: "/usr/local/bin/control-tower-fleet-export".into(),
            }],
            local_runtime: None,
        }
    }

    #[test]
    fn sample_profile_is_valid_and_bounded() {
        let profile = sample_profile();
        validate(&profile).expect("sample profile validates");
        assert_eq!(profile.version, PROFILE_VERSION);
    }

    #[test]
    fn rejects_invalid_identities_and_bindings() {
        let mut duplicate = sample_profile();
        duplicate.channels[1].id = duplicate.channels[0].id.clone();
        assert!(validate(&duplicate)
            .unwrap_err()
            .contains("duplicate channel"));

        let mut bad_author = sample_profile();
        bad_author.channels[0].authors[0].pubkey = "not-hex".into();
        assert!(validate(&bad_author).unwrap_err().contains("author pubkey"));

        let mut orphan_collector = sample_profile();
        orphan_collector.collectors[0].channel_id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa".into();
        assert!(validate(&orphan_collector)
            .unwrap_err()
            .contains("unlisted channel"));

        let mut relative_command = sample_profile();
        relative_command.collectors[0].command = "control-tower-fleet-export; rm -rf /".into();
        assert!(validate(&relative_command)
            .unwrap_err()
            .contains("absolute path"));

        let mut option_host = sample_profile();
        option_host.collectors[0].ssh_host = "-oProxyCommand=evil@host".into();
        assert!(validate(&option_host).unwrap_err().contains("user@host"));

        let mut bad_relay = sample_profile();
        bad_relay.relay_url = "https://relay.example".into();
        assert!(validate(&bad_relay).is_err());
    }

    #[test]
    fn missing_profile_enters_onboarding_and_create_refuses_overwrite() {
        let _guard = ENV_LOCK.lock().unwrap();
        let path = std::env::temp_dir().join(format!(
            "control-tower-workspace-test-create-{}/workspace.json",
            std::process::id()
        ));
        let _ = fs::remove_file(&path);
        std::env::set_var("CONTROL_TOWER_WORKSPACE", &path);

        let missing = load_state().expect("missing profile is not an error");
        assert!(missing.profile.is_none());

        let channel = ChannelConfig {
            id: "0b7c0958-3f7f-48c8-af3f-31e549b10e31".into(),
            name: "general".into(),
            description: "Team channel".into(),
            authors: Vec::new(),
        };
        let created = create_initial_profile(
            "wss://relay.example",
            "example-team",
            "Operator",
            channel.clone(),
        )
        .expect("create initial profile");
        let profile = created.profile.expect("profile present");
        assert_eq!(profile.relay_url, "wss://relay.example");
        assert_eq!(profile.channels.len(), 1);
        assert!(profile.collectors.is_empty());

        let reloaded = load_state().expect("reload profile");
        assert_eq!(reloaded.profile, Some(profile));

        let overwrite = create_initial_profile("wss://other.example", "other", "Operator", channel);
        assert!(overwrite.unwrap_err().contains("already exists"));

        std::env::remove_var("CONTROL_TOWER_WORKSPACE");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn channel_edits_persist_and_respect_bindings() {
        let _guard = ENV_LOCK.lock().unwrap();
        let path = std::env::temp_dir().join(format!(
            "control-tower-workspace-test-edit-{}/workspace.json",
            std::process::id()
        ));
        let _ = fs::remove_file(&path);
        std::env::set_var("CONTROL_TOWER_WORKSPACE", &path);

        // No profile yet: channel edits refuse instead of inventing a workspace.
        assert!(add_channel(ChannelConfig {
            id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa".into(),
            name: "orphan".into(),
            description: String::new(),
            authors: Vec::new(),
        })
        .unwrap_err()
        .contains("no workspace profile"));

        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let profile = sample_profile();
        fs::write(&path, serde_json::to_string_pretty(&profile).unwrap()).unwrap();

        // Duplicate ids are refused before anything is written.
        assert!(add_channel(profile.channels[0].clone())
            .unwrap_err()
            .contains("already part"));

        let added = add_channel(ChannelConfig {
            id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa".into(),
            name: "fresh-channel".into(),
            description: "Just added".into(),
            authors: Vec::new(),
        })
        .expect("add channel");
        assert_eq!(added.profile.as_ref().unwrap().channels.len(), 3);
        let reloaded = load_state().expect("reload after add");
        assert_eq!(reloaded.profile.unwrap().channels.len(), 3);

        // Invalid ids never reach disk.
        assert!(add_channel(ChannelConfig {
            id: "not-a-uuid".into(),
            name: "bad".into(),
            description: String::new(),
            authors: Vec::new(),
        })
        .unwrap_err()
        .contains("not a UUID"));

        // A channel with a collector bound to it cannot be removed here.
        assert!(remove_channel("1da2b83b-c1e5-44b3-8a1c-546bf665933e")
            .unwrap_err()
            .contains("fleet collector"));

        let removed = remove_channel("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa").expect("remove");
        assert_eq!(removed.profile.as_ref().unwrap().channels.len(), 2);
        assert!(remove_channel("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
            .unwrap_err()
            .contains("not part"));

        // The last channel is protected.
        let removed = remove_channel("1da2b83b-c1e5-44b3-8a1c-546bf665933e");
        assert!(removed
            .unwrap_err()
            .contains("fleet collector"));
        let mut no_collector = load_state().unwrap().profile.unwrap();
        no_collector.collectors.clear();
        fs::write(&path, serde_json::to_string_pretty(&no_collector).unwrap()).unwrap();
        remove_channel("1da2b83b-c1e5-44b3-8a1c-546bf665933e").expect("remove unbound");
        assert!(remove_channel("0b7c0958-3f7f-48c8-af3f-31e549b10e31")
            .unwrap_err()
            .contains("last channel"));

        std::env::remove_var("CONTROL_TOWER_WORKSPACE");
        let _ = fs::remove_file(&path);
    }
}
