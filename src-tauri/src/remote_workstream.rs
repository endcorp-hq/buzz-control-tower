//! Fixed, credential-free transport for remote agent fleet observers.
//!
//! Authentication is delegated to the host operating system's existing
//! Tailscale SSH session. The webview cannot select a host or remote command;
//! every collector host, command, and channel binding comes from the validated
//! on-disk workspace profile, and identities come from each collector's
//! root-owned registry.

use std::collections::HashSet;
use std::io::Read;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::local_workstream::{redact_result, redact_visible, RuntimeWorkstreamPage};
use crate::workspace_profile::{load_or_bootstrap, CollectorConfig};

const MAX_REMOTE_DOCUMENT: usize = 10 * 1024 * 1024;
const MAX_FLEET_SOURCES: usize = 16;
const MAX_CONTEXT_FIELDS: usize = 12;
const MAX_CONTEXT_CONTENT: usize = 4_001;

#[cfg(target_os = "macos")]
const SSH_PROGRAM: &str = "/usr/bin/ssh";
#[cfg(not(target_os = "macos"))]
const SSH_PROGRAM: &str = "ssh";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSourceError {
    pub agent_pubkey: String,
    pub agent_name: String,
    pub source_label: String,
    pub detail: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CollectorError {
    pub label: String,
    pub detail: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CollectorDocument {
    pub pages: Vec<RuntimeWorkstreamPage>,
    pub errors: Vec<RemoteSourceError>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFleetDocument {
    pub pages: Vec<RuntimeWorkstreamPage>,
    pub errors: Vec<RemoteSourceError>,
    pub collector_errors: Vec<CollectorError>,
}

fn valid_roster_identity(pubkey: &str, name: &str, label: &str) -> bool {
    pubkey.len() == 64
        && pubkey.bytes().all(|byte| byte.is_ascii_hexdigit())
        && !name.trim().is_empty()
        && name.chars().count() <= 120
        && !label.trim().is_empty()
        && label.chars().count() <= 120
}

fn redact_page(page: &mut RuntimeWorkstreamPage) {
    page.agent_name = redact_visible(&page.agent_name);
    page.model = redact_visible(&page.model);
    page.workspace = redact_visible(&page.workspace);
    page.source_label = page.source_label.as_deref().map(redact_visible);
    for event in &mut page.activity {
        event.title = redact_visible(&event.title);
        event.detail = redact_visible(&event.detail);
        for parameter in &mut event.parameters {
            parameter.label = redact_visible(&parameter.label);
            parameter.value = redact_result(&parameter.value);
        }
        event.result = event.result.as_deref().map(redact_result);
    }
    for source in &mut page.context {
        source.label = redact_visible(&source.label);
        source.detail = redact_visible(&source.detail);
        source.content = source.content.as_deref().map(redact_result);
        for field in &mut source.fields {
            field.label = redact_visible(&field.label);
            field.value = redact_result(&field.value);
        }
        source.withheld_reason = source.withheld_reason.as_deref().map(redact_visible);
    }
    for item in &mut page.evidence {
        item.label = redact_visible(&item.label);
        item.detail = redact_visible(&item.detail);
    }
    for artifact in &mut page.artifacts {
        artifact.name = redact_visible(&artifact.name);
        artifact.detail = redact_visible(&artifact.detail);
    }
}

fn parse_collector_document(
    bytes: &[u8],
    expected_channel: &str,
    identities: &mut HashSet<String>,
) -> Result<CollectorDocument, String> {
    if bytes.is_empty() || bytes.len() > MAX_REMOTE_DOCUMENT {
        return Err("Fleet exporter returned an invalid document size".into());
    }
    let mut document: CollectorDocument = serde_json::from_slice(bytes)
        .map_err(|_| "Fleet exporter returned an invalid workstream document".to_string())?;
    let source_count = document.pages.len() + document.errors.len();
    if !(1..=MAX_FLEET_SOURCES).contains(&source_count) {
        return Err("Fleet exporter returned an invalid roster size".into());
    }

    for page in &mut document.pages {
        let label = page
            .source_label
            .as_deref()
            .ok_or_else(|| "Fleet exporter omitted a source label".to_string())?;
        if page.channel_id != expected_channel
            || !valid_roster_identity(&page.agent_pubkey, &page.agent_name, label)
            || !identities.insert(page.agent_pubkey.clone())
        {
            return Err("Fleet exporter returned an invalid or duplicate roster identity".into());
        }
        if page.activity.len() > 200 || page.context.len() > 16 || page.artifacts.len() > 100 {
            return Err("Fleet exporter exceeded the bounded workstream schema".into());
        }
        if page.context.iter().any(|source| {
            source.fields.len() > MAX_CONTEXT_FIELDS
                || source
                    .content
                    .as_ref()
                    .is_some_and(|content| content.chars().count() > MAX_CONTEXT_CONTENT)
        }) {
            return Err("Fleet exporter exceeded the bounded context schema".into());
        }
        redact_page(page);
    }
    for error in &mut document.errors {
        if !valid_roster_identity(&error.agent_pubkey, &error.agent_name, &error.source_label)
            || !identities.insert(error.agent_pubkey.clone())
        {
            return Err("Fleet exporter returned an invalid or duplicate roster identity".into());
        }
        error.agent_name = redact_visible(&error.agent_name);
        error.source_label = redact_visible(&error.source_label);
        error.detail = redact_visible(&error.detail);
        error.channel_id = Some(expected_channel.to_string());
    }
    Ok(document)
}

fn fetch_collector_bytes(collector: &CollectorConfig) -> Result<Vec<u8>, String> {
    let mut child = Command::new(SSH_PROGRAM)
        .args([
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-o",
            "ConnectTimeout=5",
            "-o",
            "ConnectionAttempts=1",
            "-o",
            "ServerAliveInterval=3",
            "-o",
            "ServerAliveCountMax=1",
            &collector.ssh_host,
            &collector.command,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "cannot start the operating system SSH client".to_string())?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "cannot read the fleet exporter output".to_string())?;
    let reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout
            .take((MAX_REMOTE_DOCUMENT + 1) as u64)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let deadline = Instant::now() + Duration::from_secs(15);
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|_| "cannot monitor the fleet exporter".to_string())?
        {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            return Err("Fleet exporter timed out after 15 seconds".into());
        }
        thread::sleep(Duration::from_millis(50));
    };
    let bytes = reader
        .join()
        .map_err(|_| "cannot collect the fleet exporter output".to_string())?
        .map_err(|_| "cannot read the fleet exporter output".to_string())?;

    if !status.success() {
        return Err(format!(
            "Fleet exporter unavailable (SSH exit {})",
            status.code().unwrap_or(-1)
        ));
    }
    Ok(bytes)
}

pub fn load_fleet_workstreams() -> Result<RemoteFleetDocument, String> {
    let workspace = load_or_bootstrap()?;
    let collectors = &workspace.profile.collectors;
    if collectors.is_empty() {
        return Err("the workspace profile configures no fleet collectors".into());
    }

    let mut document = RemoteFleetDocument {
        pages: Vec::new(),
        errors: Vec::new(),
        collector_errors: Vec::new(),
    };
    let mut identities = HashSet::new();
    for collector in collectors {
        let outcome = fetch_collector_bytes(collector).and_then(|bytes| {
            parse_collector_document(&bytes, &collector.channel_id, &mut identities)
        });
        match outcome {
            Ok(mut collected) => {
                document.pages.append(&mut collected.pages);
                document.errors.append(&mut collected.errors);
            }
            Err(detail) => document.collector_errors.push(CollectorError {
                label: collector.label.clone(),
                detail,
            }),
        }
    }
    if document.pages.is_empty() && document.errors.is_empty() {
        let first = &document.collector_errors[0];
        return Err(format!("{}: {}", first.label, first.detail));
    }
    Ok(document)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MOS_CHANNEL_ID: &str = "1da2b83b-c1e5-44b3-8a1c-546bf665933e";

    fn source(index: usize, name: &str, label: &str) -> (String, String, String) {
        (format!("{index:064x}"), name.into(), label.into())
    }

    fn page(source: &(String, String, String)) -> serde_json::Value {
        serde_json::json!({
            "channelId": MOS_CHANNEL_ID,
            "agentPubkey": &source.0,
            "agentName": &source.1,
            "sourceLabel": &source.2,
            "sessionId": "session",
            "turnId": "turn",
            "status": "complete",
            "startedAt": "2026-08-19T00:00:00.000Z",
            "completedAt": "2026-08-19T00:00:01.000Z",
            "model": "opencode/gpt-5.6-sol",
            "workspace": "workspace",
            "activity": [{
                "id": "activity",
                "at": "2026-08-19T00:00:00.000Z",
                "kind": "tool",
                "title": "Ran test",
                "detail": "token=secret-value",
                "status": "complete",
                "parameters": [{"label": "Command", "value": "password=secret-value"}],
                "result": "nsec1abcdefghijklmnop"
            }],
            "context": [{
                "id": "context",
                "kind": "thread",
                "label": "Trigger",
                "detail": "Safe request",
                "hash": "abcdef123456",
                "size": "20 B",
                "visibility": "summary",
                "content": "api_key=secret-value",
                "fields": [{"label": "Token", "value": "token=secret-value"}],
                "withheldReason": "private_key=secret-value"
            }],
            "evidence": [],
            "artifacts": []
        })
    }

    fn complete_document() -> Vec<u8> {
        let active = source(1, "mos-agent", "Doha · mos-agent");
        let unavailable = source(2, "thor-mos-psc", "PSC · museum bridge");
        serde_json::to_vec(&serde_json::json!({
            "pages": [page(&active)],
            "errors": [serde_json::json!({
                "agentPubkey": unavailable.0,
                "agentName": unavailable.1,
                "sourceLabel": unavailable.2,
                "detail": "unavailable"
            })]
        }))
        .expect("document json")
    }

    fn parse(bytes: &[u8]) -> Result<CollectorDocument, String> {
        parse_collector_document(bytes, MOS_CHANNEL_ID, &mut HashSet::new())
    }

    #[test]
    fn validates_every_identity_and_redacts_again() {
        let document = parse(&complete_document()).expect("document");
        let serialized = serde_json::to_string(&document).expect("serialize");
        assert!(!serialized.contains("secret-value"));
        assert!(!serialized.contains("nsec1abcdefghijklmnop"));
        assert_eq!(
            document.pages[0].context[0].content.as_deref(),
            Some("api_key=[redacted]")
        );
        assert_eq!(document.pages.len(), 1);
        assert_eq!(document.errors.len(), 1);
        assert_eq!(document.errors[0].agent_name, "thor-mos-psc");
        assert_eq!(
            document.errors[0].channel_id.as_deref(),
            Some(MOS_CHANNEL_ID)
        );
    }

    #[test]
    fn accepts_a_changed_root_owned_roster_without_a_desktop_rebuild() {
        let replacement = source(99, "new-bridge-agent", "New venue · bridge");
        let mut value: serde_json::Value =
            serde_json::from_slice(&complete_document()).expect("json");
        value["errors"][0]["agentPubkey"] = replacement.0.clone().into();
        value["errors"][0]["agentName"] = replacement.1.clone().into();
        value["errors"][0]["sourceLabel"] = replacement.2.clone().into();

        let document =
            parse(&serde_json::to_vec(&value).expect("json")).expect("roster");
        assert_eq!(document.errors[0].agent_pubkey, replacement.0);
        assert_eq!(document.errors[0].agent_name, replacement.1);
    }

    #[test]
    fn rejects_empty_duplicate_or_wrong_channel_rosters() {
        let empty =
            serde_json::to_vec(&serde_json::json!({"pages": [], "errors": []})).expect("json");
        assert!(parse(&empty).unwrap_err().contains("roster size"));

        let mut duplicate: serde_json::Value =
            serde_json::from_slice(&complete_document()).expect("json");
        duplicate["errors"][0]["agentPubkey"] = duplicate["pages"][0]["agentPubkey"].clone();
        assert!(parse(&serde_json::to_vec(&duplicate).expect("json"))
            .unwrap_err()
            .contains("duplicate"));

        let mut wrong_channel: serde_json::Value =
            serde_json::from_slice(&complete_document()).expect("json");
        wrong_channel["pages"][0]["channelId"] = "00000000-0000-0000-0000-000000000000".into();
        assert!(parse(&serde_json::to_vec(&wrong_channel).expect("json"))
            .unwrap_err()
            .contains("invalid"));
    }

    #[test]
    fn rejects_duplicate_identities_across_collectors() {
        let mut identities = HashSet::new();
        parse_collector_document(&complete_document(), MOS_CHANNEL_ID, &mut identities)
            .expect("first collector");
        assert!(
            parse_collector_document(&complete_document(), MOS_CHANNEL_ID, &mut identities)
                .unwrap_err()
                .contains("duplicate")
        );
    }

    #[test]
    #[ignore = "requires Tailscale SSH access to the deployed fleet exporter"]
    fn live_fleet_probe_uses_the_fixed_redacted_contract() {
        let document = load_fleet_workstreams().expect("fleet workstreams");
        assert!(document.pages.len() + document.errors.len() >= 3);
        let serialized = serde_json::to_string(&document).expect("serialize");
        for forbidden in [
            "reasoningEncryptedContent",
            "private prompt",
            "patchText",
            "tokens_input",
        ] {
            assert!(!serialized.contains(forbidden), "leaked {forbidden}");
        }
    }
}
