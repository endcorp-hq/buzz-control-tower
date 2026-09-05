//! Runtime workspace profiles: the single source of relay, channel, author,
//! collector, and local-runtime bindings.
//!
//! On disk this is one user-owned JSON document (`workspace.json`) holding a
//! list of workspaces — one relay each — plus which one is active. The app
//! observes exactly one workspace at a time; switching retargets every relay
//! read to that workspace's relay. Version-1 files (a single bare profile,
//! written by every release up to v0.9.x) load transparently as a one-entry
//! document and are rewritten in the new shape on the next mutation.
//!
//! The document is edited by the deterministic `tower` CLI (`scripts/tower.mjs`)
//! or any operator tooling. Native code loads and validates it from disk and
//! hands the webview a bounded, already-validated view: the active workspace's
//! profile plus a summary of every workspace. Nothing is compiled in and no
//! workspace is joined automatically: with no document on disk the app enters
//! onboarding.
//!
//! The webview-reachable writes are deliberately narrow: `create_initial_profile`
//! (which refuses to run once a document exists), `add_workspace` /
//! `remove_workspace` / `switch_workspace`, and `add_channel` / `remove_channel`
//! on the active workspace. Every write re-runs the full document validation
//! before persisting. Everything else — collectors, pinned authors, the local
//! runtime — stays an operator/CLI action.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::relay_activity::http_query_url;

/// Per-workspace profile version (the only version-1 shape ever written).
pub const PROFILE_VERSION: u32 = 1;
/// On-disk document version: a list of workspaces plus the active id.
pub const DOCUMENT_VERSION: u32 = 2;
const MAX_PROFILE_BYTES: u64 = 256 * 1024;
const MAX_WORKSPACES: usize = 8;
const MAX_WORKSPACE_ID: usize = 48;
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

fn profile_version() -> u32 {
    PROFILE_VERSION
}

fn is_profile_version(version: &u32) -> bool {
    *version == PROFILE_VERSION
}

/// One workspace: a relay and everything observed on it. Inside a version-2
/// document the entry carries an `id` and omits `version`; a bare version-1
/// file is this same shape with `version: 1` and no `id`.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceProfile {
    #[serde(default = "profile_version", skip_serializing_if = "is_profile_version")]
    pub version: u32,
    #[serde(default)]
    pub id: String,
    pub workspace: String,
    pub viewer_name: String,
    pub relay_url: String,
    pub channels: Vec<ChannelConfig>,
    #[serde(default)]
    pub collectors: Vec<CollectorConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_runtime: Option<LocalRuntimeConfig>,
}

/// The on-disk document: every workspace this Tower knows plus the active one.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceDocument {
    pub version: u32,
    pub active_workspace: String,
    pub workspaces: Vec<WorkspaceProfile>,
}

/// Bounded per-workspace summary for the switcher.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSummary {
    pub id: String,
    pub workspace: String,
    pub relay_url: String,
    pub channel_count: usize,
    pub active: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceState {
    pub path: String,
    /// The active workspace. `None` means no document exists yet — the app
    /// shows onboarding.
    pub profile: Option<WorkspaceProfile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_workspace_id: Option<String>,
    /// Every workspace in the document, in document order.
    pub workspaces: Vec<WorkspaceSummary>,
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

fn valid_workspace_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_WORKSPACE_ID
        && !value.starts_with('-')
        && !value.ends_with('-')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

/// Derive a stable, human-readable workspace id from the relay host
/// (`wss://buzz.example.org:443/` -> `buzz-example-org`), made unique against
/// `taken` with a numeric suffix.
pub fn workspace_id_for(relay_url: &str, taken: &[String]) -> String {
    let host = relay_url
        .trim()
        .split("://")
        .nth(1)
        .unwrap_or(relay_url)
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default()
        .rsplit('@')
        .next()
        .unwrap_or_default()
        .split(':')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mut slug = String::new();
    for ch in host.chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            slug.push(ch);
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
        if slug.len() >= MAX_WORKSPACE_ID - 4 {
            break;
        }
    }
    let base = slug.trim_matches('-').to_string();
    let base = if base.is_empty() { "workspace".to_string() } else { base };
    if !taken.iter().any(|existing| existing == &base) {
        return base;
    }
    (2..)
        .map(|n| format!("{base}-{n}"))
        .find(|candidate| !taken.iter().any(|existing| existing == candidate))
        .expect("an unused suffix exists")
}

/// Validate the whole document: version, workspace count, unique well-formed
/// ids, an active id that exists, and every workspace on its own.
pub fn validate_document(document: &WorkspaceDocument) -> Result<(), String> {
    if document.version != DOCUMENT_VERSION {
        return Err(format!(
            "workspace document version must be {DOCUMENT_VERSION}"
        ));
    }
    if document.workspaces.is_empty() || document.workspaces.len() > MAX_WORKSPACES {
        return Err(format!("document must list 1 to {MAX_WORKSPACES} workspaces"));
    }
    let mut ids: Vec<&str> = Vec::new();
    for workspace in &document.workspaces {
        if !valid_workspace_id(&workspace.id) {
            return Err(format!(
                "workspace id must be 1 to {MAX_WORKSPACE_ID} lowercase letters, digits, or dashes: {:?}",
                workspace.id
            ));
        }
        if ids.contains(&workspace.id.as_str()) {
            return Err(format!("duplicate workspace id: {}", workspace.id));
        }
        ids.push(workspace.id.as_str());
        validate(workspace).map_err(|error| format!("workspace {}: {error}", workspace.id))?;
    }
    if !ids.contains(&document.active_workspace.as_str()) {
        return Err(format!(
            "active workspace {} is not in the document",
            document.active_workspace
        ));
    }
    Ok(())
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

fn document_from_body(body: &str, display_path: &str) -> Result<WorkspaceDocument, String> {
    let value: serde_json::Value = serde_json::from_str(body)
        .map_err(|error| format!("workspace profile at {display_path} is not valid: {error}"))?;
    let version = value.get("version").and_then(serde_json::Value::as_u64);
    let document = if version == Some(u64::from(DOCUMENT_VERSION)) {
        serde_json::from_value::<WorkspaceDocument>(value)
            .map_err(|error| format!("workspace profile at {display_path} is not valid: {error}"))?
    } else {
        // Version 1: a single bare profile. Wrap it as the only, active
        // workspace; nothing is written until the next mutation.
        let profile: WorkspaceProfile = serde_json::from_value(value)
            .map_err(|error| format!("workspace profile at {display_path} is not valid: {error}"))?;
        migrate_profile(profile)
    };
    validate_document(&document)
        .map_err(|error| format!("workspace profile at {display_path} is not valid: {error}"))?;
    Ok(document)
}

fn migrate_profile(mut profile: WorkspaceProfile) -> WorkspaceDocument {
    if profile.id.is_empty() {
        profile.id = workspace_id_for(&profile.relay_url, &[]);
    }
    WorkspaceDocument {
        version: DOCUMENT_VERSION,
        active_workspace: profile.id.clone(),
        workspaces: vec![profile],
    }
}

fn load_document() -> Result<(PathBuf, Option<WorkspaceDocument>), String> {
    let path = profile_path()?;
    let display_path = path.to_string_lossy().into_owned();
    if !path.exists() {
        return Ok((path, None));
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
    let document = document_from_body(&body, &display_path)?;
    Ok((path, Some(document)))
}

fn state_for(path: &PathBuf, document: Option<&WorkspaceDocument>) -> WorkspaceState {
    let display_path = path.to_string_lossy().into_owned();
    let Some(document) = document else {
        return WorkspaceState {
            path: display_path,
            profile: None,
            active_workspace_id: None,
            workspaces: Vec::new(),
        };
    };
    let active = document
        .workspaces
        .iter()
        .find(|workspace| workspace.id == document.active_workspace)
        .cloned();
    WorkspaceState {
        path: display_path,
        active_workspace_id: active.as_ref().map(|workspace| workspace.id.clone()),
        workspaces: document
            .workspaces
            .iter()
            .map(|workspace| WorkspaceSummary {
                id: workspace.id.clone(),
                workspace: workspace.workspace.clone(),
                relay_url: workspace.relay_url.clone(),
                channel_count: workspace.channels.len(),
                active: workspace.id == document.active_workspace,
            })
            .collect(),
        profile: active,
    }
}

pub fn load_state() -> Result<WorkspaceState, String> {
    let (path, document) = load_document()?;
    Ok(state_for(&path, document.as_ref()))
}

fn new_workspace(
    id: String,
    relay_url: &str,
    workspace: &str,
    viewer_name: &str,
    channel: ChannelConfig,
) -> WorkspaceProfile {
    WorkspaceProfile {
        version: PROFILE_VERSION,
        id,
        workspace: workspace.trim().to_string(),
        viewer_name: viewer_name.trim().to_string(),
        relay_url: relay_url.trim().to_string(),
        channels: vec![channel],
        collectors: Vec::new(),
        local_runtime: None,
    }
}

/// First-run onboarding write: create the document with one workspace for one
/// relay and one channel. Refuses to touch an existing document, so this is
/// only reachable while the app is in the onboarding state.
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
            "a workspace profile already exists at {display_path}; add a workspace instead or edit it with the tower CLI"
        ));
    }
    let id = workspace_id_for(relay_url, &[]);
    let document = WorkspaceDocument {
        version: DOCUMENT_VERSION,
        active_workspace: id.clone(),
        workspaces: vec![new_workspace(id, relay_url, workspace, viewer_name, channel)],
    };
    validate_document(&document)?;
    write_document(&path, &document)?;
    Ok(state_for(&path, Some(&document)))
}

/// Add another workspace (one relay, one first channel) and make it active.
/// The whole document is validated before anything is written, so the
/// workspace cap and per-workspace rules all apply.
pub fn add_workspace(
    relay_url: &str,
    workspace: &str,
    viewer_name: &str,
    channel: ChannelConfig,
) -> Result<WorkspaceState, String> {
    let (path, mut document) = load_document_for_edit()?;
    let taken: Vec<String> = document
        .workspaces
        .iter()
        .map(|existing| existing.id.clone())
        .collect();
    let id = workspace_id_for(relay_url, &taken);
    document
        .workspaces
        .push(new_workspace(id.clone(), relay_url, workspace, viewer_name, channel));
    document.active_workspace = id;
    validate_document(&document)?;
    write_document(&path, &document)?;
    Ok(state_for(&path, Some(&document)))
}

/// Make `workspace_id` the active workspace. Every relay read retargets on
/// the app's next refresh; nothing else about the document changes.
pub fn switch_workspace(workspace_id: &str) -> Result<WorkspaceState, String> {
    let (path, mut document) = load_document_for_edit()?;
    if !document
        .workspaces
        .iter()
        .any(|workspace| workspace.id == workspace_id)
    {
        return Err(format!("workspace {workspace_id} is not in the document"));
    }
    if document.active_workspace != workspace_id {
        document.active_workspace = workspace_id.to_string();
        validate_document(&document)?;
        write_document(&path, &document)?;
    }
    Ok(state_for(&path, Some(&document)))
}

/// Remove a workspace. Refuses to remove the last one; removing the active
/// workspace activates the first remaining entry.
pub fn remove_workspace(workspace_id: &str) -> Result<WorkspaceState, String> {
    let (path, mut document) = load_document_for_edit()?;
    if !document
        .workspaces
        .iter()
        .any(|workspace| workspace.id == workspace_id)
    {
        return Err(format!("workspace {workspace_id} is not in the document"));
    }
    if document.workspaces.len() == 1 {
        return Err(
            "cannot remove the last workspace; the Tower must observe at least one relay".into(),
        );
    }
    document
        .workspaces
        .retain(|workspace| workspace.id != workspace_id);
    if document.active_workspace == workspace_id {
        document.active_workspace = document.workspaces[0].id.clone();
    }
    validate_document(&document)?;
    write_document(&path, &document)?;
    Ok(state_for(&path, Some(&document)))
}

fn write_document(path: &PathBuf, document: &WorkspaceDocument) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("cannot create the workspace profile directory: {error}"))?;
    }
    let body = serde_json::to_string_pretty(document)
        .map_err(|error| format!("cannot encode the workspace profile: {error}"))?;
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, body + "\n")
        .map_err(|error| format!("cannot write the workspace profile: {error}"))?;
    fs::rename(&temp, path)
        .map_err(|error| format!("cannot finalize the workspace profile: {error}"))?;
    Ok(())
}

/// Load the existing document or explain why an edit cannot proceed.
fn load_document_for_edit() -> Result<(PathBuf, WorkspaceDocument), String> {
    let (path, document) = load_document()?;
    let document = document.ok_or_else(|| {
        format!(
            "no workspace profile exists at {}",
            path.to_string_lossy()
        )
    })?;
    Ok((path, document))
}

/// Apply `edit` to the active workspace, validate the whole document, persist.
fn edit_active_workspace(
    edit: impl FnOnce(&mut WorkspaceProfile) -> Result<(), String>,
) -> Result<WorkspaceState, String> {
    let (path, mut document) = load_document_for_edit()?;
    let active = document.active_workspace.clone();
    let profile = document
        .workspaces
        .iter_mut()
        .find(|workspace| workspace.id == active)
        .ok_or_else(|| format!("active workspace {active} is not in the document"))?;
    edit(profile)?;
    validate_document(&document)?;
    write_document(&path, &document)?;
    Ok(state_for(&path, Some(&document)))
}

/// Append a channel to the active workspace's observed-channel list. The full
/// validation runs before anything is persisted, so the channel cap, UUID
/// shape, and duplicate checks all apply.
pub fn add_channel(channel: ChannelConfig) -> Result<WorkspaceState, String> {
    edit_active_workspace(|profile| {
        if profile.channels.iter().any(|existing| existing.id == channel.id) {
            return Err(format!(
                "channel {} is already part of this workspace",
                channel.id
            ));
        }
        profile.channels.push(channel);
        Ok(())
    })
}

/// Remove a channel from the active workspace. Refuses to orphan fleet
/// collectors or the local runtime — unbinding those stays a CLI action — and
/// refuses to remove the last channel.
pub fn remove_channel(channel_id: &str) -> Result<WorkspaceState, String> {
    edit_active_workspace(|profile| {
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
        Ok(())
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
            id: "relay-example".into(),
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
        assert_eq!(profile.id, "relay-example");
        assert_eq!(profile.channels.len(), 1);
        assert!(profile.collectors.is_empty());
        assert_eq!(created.active_workspace_id.as_deref(), Some("relay-example"));
        assert_eq!(created.workspaces.len(), 1);
        assert!(created.workspaces[0].active);

        // Written in the version-2 document shape.
        let body = fs::read_to_string(&path).unwrap();
        let on_disk: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(on_disk["version"], DOCUMENT_VERSION);
        assert_eq!(on_disk["activeWorkspace"], "relay-example");
        assert!(on_disk["workspaces"][0].get("version").is_none());

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
        // A real version-1 file: bare profile, `version: 1`, no id.
        let mut profile = sample_profile();
        profile.id = String::new();
        let mut v1 = serde_json::to_value(&profile).unwrap();
        v1["version"] = serde_json::json!(PROFILE_VERSION);
        fs::write(&path, serde_json::to_string_pretty(&v1).unwrap()).unwrap();

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
        // The first mutation rewrote the version-1 file as a document with a
        // derived id.
        assert_eq!(added.active_workspace_id.as_deref(), Some("relay-example"));
        let on_disk: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(on_disk["version"], DOCUMENT_VERSION);
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
        let document = WorkspaceDocument {
            version: DOCUMENT_VERSION,
            active_workspace: no_collector.id.clone(),
            workspaces: vec![no_collector],
        };
        fs::write(&path, serde_json::to_string_pretty(&document).unwrap()).unwrap();
        remove_channel("1da2b83b-c1e5-44b3-8a1c-546bf665933e").expect("remove unbound");
        assert!(remove_channel("0b7c0958-3f7f-48c8-af3f-31e549b10e31")
            .unwrap_err()
            .contains("last channel"));

        std::env::remove_var("CONTROL_TOWER_WORKSPACE");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn workspace_ids_derive_from_relay_hosts_and_stay_unique() {
        assert_eq!(workspace_id_for("wss://buzz.nilor.cool", &[]), "buzz-nilor-cool");
        assert_eq!(
            workspace_id_for("ws://Relay.Example.ORG:8443/path?x=1", &[]),
            "relay-example-org"
        );
        assert_eq!(workspace_id_for("wss://", &[]), "workspace");
        let taken = vec!["buzz-nilor-cool".to_string(), "buzz-nilor-cool-2".to_string()];
        assert_eq!(workspace_id_for("wss://buzz.nilor.cool", &taken), "buzz-nilor-cool-3");
        assert!(valid_workspace_id(&workspace_id_for("wss://x--y.example", &[])));
    }

    #[test]
    fn version_one_files_load_as_a_single_active_workspace() {
        let mut profile = sample_profile();
        profile.id = String::new();
        let mut v1 = serde_json::to_value(&profile).unwrap();
        v1["version"] = serde_json::json!(PROFILE_VERSION);
        let document = document_from_body(&v1.to_string(), "test").expect("v1 migrates");
        assert_eq!(document.version, DOCUMENT_VERSION);
        assert_eq!(document.active_workspace, "relay-example");
        assert_eq!(document.workspaces.len(), 1);
        assert_eq!(document.workspaces[0].relay_url, "wss://relay.example");
        assert_eq!(document.workspaces[0].channels.len(), 2);

        // Unknown versions and broken documents are refused, not guessed.
        v1["version"] = serde_json::json!(7);
        assert!(document_from_body(&v1.to_string(), "test").is_err());
        let bad_active = serde_json::json!({
            "version": DOCUMENT_VERSION,
            "activeWorkspace": "missing",
            "workspaces": [serde_json::to_value(sample_profile()).unwrap()],
        });
        assert!(document_from_body(&bad_active.to_string(), "test")
            .unwrap_err()
            .contains("active workspace"));
        let dup = serde_json::json!({
            "version": DOCUMENT_VERSION,
            "activeWorkspace": "relay-example",
            "workspaces": [
                serde_json::to_value(sample_profile()).unwrap(),
                serde_json::to_value(sample_profile()).unwrap(),
            ],
        });
        assert!(document_from_body(&dup.to_string(), "test")
            .unwrap_err()
            .contains("duplicate workspace id"));
    }

    #[test]
    fn workspaces_can_be_added_switched_and_removed() {
        let _guard = ENV_LOCK.lock().unwrap();
        let path = std::env::temp_dir().join(format!(
            "control-tower-workspace-test-multi-{}/workspace.json",
            std::process::id()
        ));
        let _ = fs::remove_file(&path);
        std::env::set_var("CONTROL_TOWER_WORKSPACE", &path);

        let channel = ChannelConfig {
            id: "0b7c0958-3f7f-48c8-af3f-31e549b10e31".into(),
            name: "general".into(),
            description: String::new(),
            authors: Vec::new(),
        };
        // No document yet: adding a workspace refuses instead of inventing one.
        assert!(add_workspace("wss://second.example", "second", "Operator", channel.clone())
            .unwrap_err()
            .contains("no workspace profile"));

        create_initial_profile("wss://relay.example", "first", "Operator", channel.clone())
            .expect("create");
        let added = add_workspace("wss://second.example", "second", "Operator", channel.clone())
            .expect("add workspace");
        assert_eq!(added.active_workspace_id.as_deref(), Some("second-example"));
        assert_eq!(added.profile.as_ref().unwrap().relay_url, "wss://second.example");
        assert_eq!(
            added
                .workspaces
                .iter()
                .map(|workspace| (workspace.id.as_str(), workspace.active))
                .collect::<Vec<_>>(),
            vec![("relay-example", false), ("second-example", true)]
        );

        // Same relay twice gets a distinct id.
        let again = add_workspace("wss://second.example", "second-b", "Operator", channel.clone())
            .expect("add duplicate relay");
        assert_eq!(again.active_workspace_id.as_deref(), Some("second-example-2"));

        // Channel edits apply to the active workspace only.
        add_channel(ChannelConfig {
            id: "1da2b83b-c1e5-44b3-8a1c-546bf665933e".into(),
            name: "ops".into(),
            description: String::new(),
            authors: Vec::new(),
        })
        .expect("add channel to active");
        let switched = switch_workspace("relay-example").expect("switch");
        assert_eq!(switched.active_workspace_id.as_deref(), Some("relay-example"));
        assert_eq!(switched.profile.as_ref().unwrap().channels.len(), 1);
        assert_eq!(
            load_state().unwrap().active_workspace_id.as_deref(),
            Some("relay-example"),
            "switch persists"
        );
        assert!(switch_workspace("nope").unwrap_err().contains("not in the document"));

        // Removing the active workspace falls back to the first remaining one.
        let removed = remove_workspace("relay-example").expect("remove active");
        assert_eq!(removed.active_workspace_id.as_deref(), Some("second-example"));
        assert_eq!(removed.workspaces.len(), 2);
        remove_workspace("second-example-2").expect("remove inactive");
        assert!(remove_workspace("second-example")
            .unwrap_err()
            .contains("last workspace"));

        std::env::remove_var("CONTROL_TOWER_WORKSPACE");
        let _ = fs::remove_file(&path);
    }
}
