//! Fixed, credential-free transport for the Doha mos-agent observer slice.
//!
//! Authentication is delegated to the host operating system's existing
//! Tailscale SSH session. The webview cannot select a host or remote command.

use std::io::Read;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use crate::local_workstream::{redact_result, redact_visible, RuntimeWorkstreamPage};

const DOHA_HOST: &str = "root@100.119.77.122";
const EXPORT_COMMAND: &str = "/usr/local/bin/control-tower-opencode-export";
const MOS_CHANNEL_ID: &str = "1da2b83b-c1e5-44b3-8a1c-546bf665933e";
const MOS_AGENT_PUBKEY: &str = "e802d3594a2b31b22f35c6a42a17e1749d62decaceef5abe96841512607fdd00";
const MOS_AGENT_NAME: &str = "mos-agent";
const MAX_REMOTE_DOCUMENT: usize = 2 * 1024 * 1024;

#[cfg(target_os = "macos")]
const SSH_PROGRAM: &str = "/usr/bin/ssh";
#[cfg(not(target_os = "macos"))]
const SSH_PROGRAM: &str = "ssh";

fn parse_page(bytes: &[u8]) -> Result<RuntimeWorkstreamPage, String> {
    if bytes.is_empty() || bytes.len() > MAX_REMOTE_DOCUMENT {
        return Err("Doha exporter returned an invalid document size".into());
    }
    let mut page: RuntimeWorkstreamPage = serde_json::from_slice(bytes)
        .map_err(|_| "Doha exporter returned an invalid workstream document".to_string())?;
    if page.channel_id != MOS_CHANNEL_ID
        || page.agent_pubkey != MOS_AGENT_PUBKEY
        || page.agent_name != MOS_AGENT_NAME
    {
        return Err("Doha exporter identity does not match the configured source".into());
    }
    if page.activity.len() > 200 || page.context.len() > 16 || page.artifacts.len() > 100 {
        return Err("Doha exporter exceeded the bounded workstream schema".into());
    }

    // Defense in depth: the exporter redacts before transport, and the native
    // client applies the same boundary once more before values reach React.
    page.model = redact_visible(&page.model);
    page.workspace = redact_visible(&page.workspace);
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
    }
    for item in &mut page.evidence {
        item.label = redact_visible(&item.label);
        item.detail = redact_visible(&item.detail);
    }
    for artifact in &mut page.artifacts {
        artifact.name = redact_visible(&artifact.name);
        artifact.detail = redact_visible(&artifact.detail);
    }
    Ok(page)
}

pub fn load_doha_mos_workstream() -> Result<RuntimeWorkstreamPage, String> {
    let mut child = Command::new(SSH_PROGRAM)
        .args([
            "-o",
            "BatchMode=yes",
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
            "--channel-id",
            MOS_CHANNEL_ID,
            "--agent-pubkey",
            MOS_AGENT_PUBKEY,
            "--agent-name",
            MOS_AGENT_NAME,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "cannot start the operating system SSH client".to_string())?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "cannot read the Doha exporter output".to_string())?;
    let reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout
            .take((MAX_REMOTE_DOCUMENT + 1) as u64)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let deadline = Instant::now() + Duration::from_secs(12);
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|_| "cannot monitor the Doha exporter".to_string())?
        {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            return Err("Doha exporter timed out after 12 seconds".into());
        }
        thread::sleep(Duration::from_millis(50));
    };
    let bytes = reader
        .join()
        .map_err(|_| "cannot collect the Doha exporter output".to_string())?
        .map_err(|_| "cannot read the Doha exporter output".to_string())?;

    if !status.success() {
        return Err(format!(
            "Doha exporter unavailable (SSH exit {})",
            status.code().unwrap_or(-1)
        ));
    }
    parse_page(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page_json(channel: &str, pubkey: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "channelId": channel,
            "agentPubkey": pubkey,
            "agentName": MOS_AGENT_NAME,
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
            "context": [],
            "evidence": [],
            "artifacts": []
        }))
        .expect("page json")
    }

    #[test]
    fn validates_identity_and_redacts_again() {
        let page = parse_page(&page_json(MOS_CHANNEL_ID, MOS_AGENT_PUBKEY)).expect("page");
        let serialized = serde_json::to_string(&page).expect("serialize");
        assert!(!serialized.contains("secret-value"));
        assert!(!serialized.contains("nsec1abcdefghijklmnop"));
    }

    #[test]
    fn rejects_unconfigured_agent() {
        let error = parse_page(&page_json(MOS_CHANNEL_ID, &"0".repeat(64))).unwrap_err();
        assert!(error.contains("identity"));
    }

    #[test]
    #[ignore = "requires Tailscale SSH access to the deployed Doha exporter"]
    fn live_doha_probe_uses_the_fixed_redacted_contract() {
        let page = load_doha_mos_workstream().expect("Doha workstream");
        assert_eq!(page.channel_id, MOS_CHANNEL_ID);
        assert_eq!(page.agent_pubkey, MOS_AGENT_PUBKEY);
        assert!(!page.activity.is_empty());
        let serialized = serde_json::to_string(&page).expect("serialize");
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
