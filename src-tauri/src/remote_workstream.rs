//! Fixed, credential-free transport for the MOS agent fleet observer.
//!
//! Authentication is delegated to the host operating system's existing
//! Tailscale SSH session. The webview cannot select a host or remote command;
//! it receives only a bounded document whose identities match this allowlist.

use std::collections::HashSet;
use std::io::Read;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::local_workstream::{redact_result, redact_visible, RuntimeWorkstreamPage};

const DOHA_HOST: &str = "control-tower@mos-agent.tailc8418d.ts.net";
const EXPORT_COMMAND: &str = "/usr/local/bin/control-tower-fleet-export";
const MOS_CHANNEL_ID: &str = "1da2b83b-c1e5-44b3-8a1c-546bf665933e";
const MAX_REMOTE_DOCUMENT: usize = 10 * 1024 * 1024;
const MAX_CONTEXT_FIELDS: usize = 12;
const MAX_CONTEXT_CONTENT: usize = 4_001;

const MOS_SOURCES: [(&str, &str, &str); 6] = [
    (
        "e802d3594a2b31b22f35c6a42a17e1749d62decaceef5abe96841512607fdd00",
        "mos-agent",
        "Doha · mos-agent",
    ),
    (
        "f5171ae5d2877ab58ed3b38168728e32b31a956a64ba0159924ec4d21b77bd4f",
        "lucas-mos-agent",
        "Doha · lucas-mos-agent",
    ),
    (
        "9c16889d1df147e168507c362ea4c7532ddf3c4976e943f64eb070ae42d50405",
        "dany-mos-agent",
        "Doha · dany-mos-agent",
    ),
    (
        "963ba9398cb139ed5c7516924c3398e18699efbd9bb45d5eb03cfe43d25c6950",
        "vivid-bridge-mos-agent",
        "Vivid studio · continuity bridge",
    ),
    (
        "ec6bc8dc548a6e3f63c8ffe5cc93092b9fbfe7888c4d941e0804182109fa617b",
        "Thor",
        "Vivid studio · Thor",
    ),
    (
        "21468ab6f07d19c38c3545f17f72a08e0d4bda4e1efe214e4177a860d8aa54a1",
        "museum-bridge-mos-agent",
        "PSC · museum bridge",
    ),
];

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
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFleetDocument {
    pub pages: Vec<RuntimeWorkstreamPage>,
    pub errors: Vec<RemoteSourceError>,
}

fn configured_source(pubkey: &str, name: &str, label: &str) -> bool {
    MOS_SOURCES
        .iter()
        .any(|source| source == &(pubkey, name, label))
}

fn redact_page(page: &mut RuntimeWorkstreamPage) {
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

fn parse_document(bytes: &[u8]) -> Result<RemoteFleetDocument, String> {
    if bytes.is_empty() || bytes.len() > MAX_REMOTE_DOCUMENT {
        return Err("Fleet exporter returned an invalid document size".into());
    }
    let mut document: RemoteFleetDocument = serde_json::from_slice(bytes)
        .map_err(|_| "Fleet exporter returned an invalid workstream document".to_string())?;
    if document.pages.len() + document.errors.len() != MOS_SOURCES.len() {
        return Err("Fleet exporter did not account for every configured source".into());
    }

    let mut identities = HashSet::new();
    for page in &mut document.pages {
        let label = page
            .source_label
            .as_deref()
            .ok_or_else(|| "Fleet exporter omitted a source label".to_string())?;
        if page.channel_id != MOS_CHANNEL_ID
            || !configured_source(&page.agent_pubkey, &page.agent_name, label)
            || !identities.insert(page.agent_pubkey.clone())
        {
            return Err("Fleet exporter identity does not match the configured source".into());
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
        if !configured_source(&error.agent_pubkey, &error.agent_name, &error.source_label)
            || !identities.insert(error.agent_pubkey.clone())
        {
            return Err(
                "Fleet exporter error identity does not match the configured source".into(),
            );
        }
        error.agent_name = redact_visible(&error.agent_name);
        error.source_label = redact_visible(&error.source_label);
        error.detail = redact_visible(&error.detail);
    }
    Ok(document)
}

pub fn load_mos_fleet_workstreams() -> Result<RemoteFleetDocument, String> {
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
            DOHA_HOST,
            EXPORT_COMMAND,
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
    parse_document(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(source: (&str, &str, &str)) -> serde_json::Value {
        serde_json::json!({
            "channelId": MOS_CHANNEL_ID,
            "agentPubkey": source.0,
            "agentName": source.1,
            "sourceLabel": source.2,
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
        serde_json::to_vec(&serde_json::json!({
            "pages": [page(MOS_SOURCES[0])],
            "errors": MOS_SOURCES[1..].iter().map(|source| serde_json::json!({
                "agentPubkey": source.0,
                "agentName": source.1,
                "sourceLabel": source.2,
                "detail": "unavailable"
            })).collect::<Vec<_>>()
        }))
        .expect("document json")
    }

    #[test]
    fn validates_every_identity_and_redacts_again() {
        let document = parse_document(&complete_document()).expect("document");
        let serialized = serde_json::to_string(&document).expect("serialize");
        assert!(!serialized.contains("secret-value"));
        assert!(!serialized.contains("nsec1abcdefghijklmnop"));
        assert_eq!(
            document.pages[0].context[0].content.as_deref(),
            Some("api_key=[redacted]")
        );
        assert_eq!(document.pages.len(), 1);
        assert_eq!(document.errors.len(), 5);
    }

    #[test]
    fn rejects_unconfigured_or_missing_agent() {
        let mut value: serde_json::Value =
            serde_json::from_slice(&complete_document()).expect("json");
        value["errors"].as_array_mut().expect("errors").pop();
        let error = parse_document(&serde_json::to_vec(&value).expect("json")).unwrap_err();
        assert!(error.contains("every configured source"));
    }

    #[test]
    #[ignore = "requires Tailscale SSH access to the deployed fleet exporter"]
    fn live_fleet_probe_uses_the_fixed_redacted_contract() {
        let document = load_mos_fleet_workstreams().expect("fleet workstreams");
        assert!(document.pages.len() >= 3);
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
