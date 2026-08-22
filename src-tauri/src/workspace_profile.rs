//! Runtime workspace profile: the single source of relay, channel, author,
//! collector, and local-runtime bindings.
//!
//! The profile is a user-owned JSON file edited by the deterministic `tower`
//! CLI (`scripts/tower.mjs`) or any operator tooling. The webview never
//! supplies these values; native code loads and validates the profile from
//! disk and hands the webview a bounded, already-validated document. On first
//! launch the current compiled workspace is written out as the initial
//! profile, so existing installations keep working without any setup step.

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
pub struct WorkspaceDocument {
    pub profile: WorkspaceProfile,
    pub path: String,
    pub bootstrapped: bool,
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
            return Err(format!("channel {} has an invalid name or description", channel.id));
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
            return Err(format!("collector {} has an invalid user@host", collector.label));
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

pub fn default_profile() -> WorkspaceProfile {
    WorkspaceProfile {
        version: PROFILE_VERSION,
        workspace: "nilor.cool".into(),
        viewer_name: "Lucas".into(),
        relay_url: "wss://buzz.nilor.cool".into(),
        channels: vec![
            ChannelConfig {
                id: "0b7c0958-3f7f-48c8-af3f-31e549b10e31".into(),
                name: "buzz-control-tower".into(),
                description: "Product development for the Buzz observability companion".into(),
                authors: vec![AuthorConfig {
                    pubkey: "19215c80f8a71880f8c5738410d041e8afb2093bde1df8b4b691f23a50cb8b13"
                        .into(),
                    name: Some("Lucas-Fizz".into()),
                }],
            },
            ChannelConfig {
                id: "1da2b83b-c1e5-44b3-8a1c-546bf665933e".into(),
                name: "mos-boston".into(),
                description: "MOS Boston product development and deployment".into(),
                authors: Vec::new(),
            },
        ],
        collectors: vec![CollectorConfig {
            label: "Doha MOS fleet".into(),
            channel_id: "1da2b83b-c1e5-44b3-8a1c-546bf665933e".into(),
            ssh_host: "control-tower@mos-agent.tailc8418d.ts.net".into(),
            command: "/usr/local/bin/control-tower-fleet-export".into(),
        }],
        local_runtime: Some(LocalRuntimeConfig {
            channel_id: "0b7c0958-3f7f-48c8-af3f-31e549b10e31".into(),
            agent_pubkey: "19215c80f8a71880f8c5738410d041e8afb2093bde1df8b4b691f23a50cb8b13"
                .into(),
            agent_name: "Lucas-Fizz".into(),
        }),
    }
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

pub fn load_or_bootstrap() -> Result<WorkspaceDocument, String> {
    let path = profile_path()?;
    let display_path = path.to_string_lossy().into_owned();
    if !path.exists() {
        let profile = default_profile();
        validate(&profile)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("cannot create the workspace profile directory: {error}"))?;
        }
        let body = serde_json::to_string_pretty(&profile)
            .map_err(|error| format!("cannot encode the default workspace profile: {error}"))?;
        fs::write(&path, body + "\n")
            .map_err(|error| format!("cannot write the workspace profile: {error}"))?;
        return Ok(WorkspaceDocument {
            profile,
            path: display_path,
            bootstrapped: true,
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
    let profile: WorkspaceProfile = serde_json::from_str(&body).map_err(|error| {
        format!("workspace profile at {display_path} is not valid: {error}")
    })?;
    validate(&profile).map_err(|error| {
        format!("workspace profile at {display_path} is not valid: {error}")
    })?;
    Ok(WorkspaceDocument {
        profile,
        path: display_path,
        bootstrapped: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_profile_is_valid_and_bounded() {
        let profile = default_profile();
        validate(&profile).expect("default profile validates");
        assert_eq!(profile.version, PROFILE_VERSION);
        assert_eq!(profile.channels.len(), 2);
        assert_eq!(profile.collectors.len(), 1);
    }

    #[test]
    fn rejects_invalid_identities_and_bindings() {
        let mut duplicate = default_profile();
        duplicate.channels[1].id = duplicate.channels[0].id.clone();
        assert!(validate(&duplicate).unwrap_err().contains("duplicate channel"));

        let mut bad_author = default_profile();
        bad_author.channels[0].authors[0].pubkey = "not-hex".into();
        assert!(validate(&bad_author).unwrap_err().contains("author pubkey"));

        let mut orphan_collector = default_profile();
        orphan_collector.collectors[0].channel_id =
            "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa".into();
        assert!(validate(&orphan_collector)
            .unwrap_err()
            .contains("unlisted channel"));

        let mut relative_command = default_profile();
        relative_command.collectors[0].command = "control-tower-fleet-export; rm -rf /".into();
        assert!(validate(&relative_command)
            .unwrap_err()
            .contains("absolute path"));

        let mut option_host = default_profile();
        option_host.collectors[0].ssh_host = "-oProxyCommand=evil@host".into();
        assert!(validate(&option_host).unwrap_err().contains("user@host"));

        let mut bad_relay = default_profile();
        bad_relay.relay_url = "https://buzz.nilor.cool".into();
        assert!(validate(&bad_relay).is_err());
    }

    #[test]
    fn bootstraps_then_reloads_the_same_profile_from_disk() {
        let path = std::env::temp_dir().join(format!(
            "control-tower-workspace-test-{}/workspace.json",
            std::process::id()
        ));
        let _ = fs::remove_file(&path);
        std::env::set_var("CONTROL_TOWER_WORKSPACE", &path);

        let bootstrapped = load_or_bootstrap().expect("bootstrap profile");
        assert!(bootstrapped.bootstrapped);
        assert_eq!(bootstrapped.profile, default_profile());

        let reloaded = load_or_bootstrap().expect("reload profile");
        assert!(!reloaded.bootstrapped);
        assert_eq!(reloaded.profile, default_profile());

        std::env::remove_var("CONTROL_TOWER_WORKSPACE");
        let _ = fs::remove_file(&path);
    }
}
