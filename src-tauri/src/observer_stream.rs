//! Live encrypted observer-frame subscription — the "rich lane".
//!
//! Buzz agents publish their raw ACP activity as NIP-44 encrypted ephemeral
//! events: kind 24200 frames addressed to the agent owner, and kind 24201
//! channel-scoped copies addressed to authorized readers. Both carry this
//! identity's pubkey in the cleartext `p` tag; only holders of the matching
//! secret key can decrypt the content.
//!
//! Ephemeral events are never stored by the relay, so this module keeps a
//! long-lived authenticated WebSocket subscription open and accumulates the
//! decrypted frames into per-agent ring buffers. The frontend polls the
//! accumulated state through `load_observer_streams` on its normal refresh
//! cycle — no push plumbing, same read-only posture as every other adapter.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use nostr::nips::nip44;
use nostr::{Event, EventBuilder, Keys, RelayUrl};
use serde::Serialize;
use serde_json::{json, Value};

const OBSERVER_FRAME_KIND: u16 = 24_200;
const SHARED_OBSERVER_FRAME_KIND: u16 = 24_201;
const SUBSCRIPTION_ID: &str = "tower-rich-lane";

/// NIP-44 v2 ciphertext length envelope (mirrors the relay's own bounds).
const NIP44_MIN_CONTENT_LEN: usize = 132;
const NIP44_MAX_CONTENT_LEN: usize = 87_472;
/// Decrypted frame JSON larger than this is dropped whole.
const MAX_PLAINTEXT_BYTES: usize = 65_535;

const MAX_AGENTS: usize = 64;
const MAX_CHANNEL_FILTERS: usize = 32;
const MAX_ENTRIES_PER_AGENT: usize = 200;
const MAX_LIVE_TEXT_BYTES: usize = 16_384;
const MAX_THOUGHT_BYTES: usize = 8_192;
const MAX_DETAIL_CHARS: usize = 2_000;
const MAX_PARAM_VALUE_CHARS: usize = 240;
const MAX_PARAMS: usize = 8;

const AUTH_TIMEOUT_SECS: u64 = 20;
const READ_IDLE_TIMEOUT_SECS: u64 = 300;
const RECONNECT_MIN_SECS: u64 = 5;
const RECONNECT_MAX_SECS: u64 = 60;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RichParameter {
    pub label: String,
    pub value: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RichEntry {
    pub id: String,
    /// RFC3339 timestamp as reported by the harness observer.
    pub at: String,
    /// Frontend `ActivityEvent` kind: `tool`, `message`, or `lifecycle`.
    pub kind: String,
    pub title: String,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    pub parameters: Vec<RichParameter>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStream {
    pub channel_id: Option<String>,
    pub session_id: Option<String>,
    pub turn_id: Option<String>,
    /// Unix seconds of the last applied frame.
    pub updated_at: u64,
    /// Accumulated assistant message text for the current turn (tail-capped).
    pub live_text: String,
    /// Accumulated assistant thought text for the current turn (tail-capped).
    pub live_thought: String,
    /// Entries oldest-first internally; snapshots reverse to newest-first.
    pub entries: Vec<RichEntry>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObserverAgentStream {
    pub agent_pubkey: String,
    #[serde(flatten)]
    pub stream: AgentStream,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObserverStreamsPage {
    pub relay_url: String,
    pub connected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub agents: Vec<ObserverAgentStream>,
}

#[derive(Default)]
struct StoreInner {
    relay_url: String,
    identity_pubkey: String,
    channels: Vec<String>,
    connected: bool,
    last_error: Option<String>,
    agents: HashMap<String, AgentStream>,
}

#[derive(Clone, Default)]
pub struct ObserverStreamStore {
    inner: Arc<Mutex<StoreInner>>,
    generation: Arc<AtomicU64>,
}

impl ObserverStreamStore {
    /// Ensure a background subscription task is running for `relay_url` under
    /// `keys`, watching `channels`. Idempotent: a live task for the same
    /// relay, identity, and channel set is left alone; anything else is
    /// superseded by bumping the generation.
    pub fn ensure_started(
        &self,
        keys: Keys,
        relay_url: String,
        channels: Vec<String>,
    ) -> Result<(), String> {
        let pubkey = keys.public_key().to_hex();
        let mut channels: Vec<String> = channels
            .into_iter()
            .map(|channel| channel.trim().to_string())
            .filter(|channel| !channel.is_empty())
            .take(MAX_CHANNEL_FILTERS)
            .collect();
        channels.sort();
        channels.dedup();
        {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "observer stream lock is poisoned".to_string())?;
            let generation = self.generation.load(Ordering::SeqCst);
            if generation != 0
                && inner.relay_url == relay_url
                && inner.identity_pubkey == pubkey
                && inner.channels == channels
            {
                return Ok(());
            }
            inner.relay_url = relay_url.clone();
            inner.identity_pubkey = pubkey;
            inner.channels = channels.clone();
            inner.connected = false;
            inner.last_error = None;
            inner.agents.clear();
        }
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let store = self.clone();
        tauri::async_runtime::spawn(async move {
            run_stream(store, keys, relay_url, channels, generation).await;
        });
        Ok(())
    }

    /// Snapshot the accumulated streams, entries newest-first.
    pub fn snapshot(&self) -> Result<ObserverStreamsPage, String> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| "observer stream lock is poisoned".to_string())?;
        let mut agents: Vec<ObserverAgentStream> = inner
            .agents
            .iter()
            .map(|(pubkey, stream)| {
                let mut stream = stream.clone();
                stream.entries.reverse();
                ObserverAgentStream {
                    agent_pubkey: pubkey.clone(),
                    stream,
                }
            })
            .collect();
        agents.sort_by_key(|agent| std::cmp::Reverse(agent.stream.updated_at));
        Ok(ObserverStreamsPage {
            relay_url: inner.relay_url.clone(),
            connected: inner.connected,
            last_error: inner.last_error.clone(),
            agents,
        })
    }

    fn set_connected(&self, generation: u64, connected: bool) {
        if self.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        if let Ok(mut inner) = self.inner.lock() {
            inner.connected = connected;
            if connected {
                inner.last_error = None;
            }
        }
    }

    fn set_error(&self, generation: u64, error: String) {
        if self.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        if let Ok(mut inner) = self.inner.lock() {
            inner.connected = false;
            inner.last_error = Some(error);
        }
    }

    fn apply(&self, generation: u64, agent_pubkey: &str, frame: &Value) {
        if self.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        if let Ok(mut inner) = self.inner.lock() {
            apply_frame(&mut inner, agent_pubkey, frame);
        }
    }
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Frame semantics: observer JSON → per-agent rich stream state. Pure functions
// over `StoreInner` so the mapping is unit-testable without a socket.
// ---------------------------------------------------------------------------

fn apply_frame(inner: &mut StoreInner, agent_pubkey: &str, frame: &Value) {
    let kind = frame.get("kind").and_then(Value::as_str).unwrap_or("");
    if kind == "batch" {
        if let Some(events) = frame
            .get("payload")
            .and_then(|p| p.get("events"))
            .and_then(Value::as_array)
        {
            for event in events {
                apply_frame(inner, agent_pubkey, event);
            }
        }
        return;
    }

    if inner.agents.len() >= MAX_AGENTS && !inner.agents.contains_key(agent_pubkey) {
        return;
    }
    let stream = inner.agents.entry(agent_pubkey.to_string()).or_default();
    stream.updated_at = now_unix();
    if let Some(channel) = frame.get("channel_id").and_then(Value::as_str) {
        stream.channel_id = Some(channel.to_string());
    }
    if let Some(session) = frame.get("session_id").and_then(Value::as_str) {
        stream.session_id = Some(session.to_string());
    }
    if let Some(turn) = frame.get("turn_id").and_then(Value::as_str) {
        stream.turn_id = Some(turn.to_string());
    }
    let at = frame
        .get("timestamp")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let seq = frame.get("seq").and_then(Value::as_u64).unwrap_or(0);
    let payload = frame.get("payload").cloned().unwrap_or(Value::Null);

    match kind {
        "turn_started" => {
            stream.live_text.clear();
            stream.live_thought.clear();
            push_entry(
                stream,
                RichEntry {
                    id: format!("{seq}-turn-started"),
                    at,
                    kind: "lifecycle".into(),
                    title: "Turn started".into(),
                    detail: "Live encrypted agent stream.".into(),
                    status: Some("complete".into()),
                    parameters: Vec::new(),
                    result: None,
                },
            );
        }
        "turn_completed" => push_entry(
            stream,
            RichEntry {
                id: format!("{seq}-turn-completed"),
                at,
                kind: "lifecycle".into(),
                title: "Turn completed".into(),
                detail: String::new(),
                status: Some("complete".into()),
                parameters: Vec::new(),
                result: None,
            },
        ),
        "turn_error" | "agent_panic" => push_entry(
            stream,
            RichEntry {
                id: format!("{seq}-{kind}"),
                at,
                kind: "lifecycle".into(),
                title: if kind == "turn_error" {
                    "Turn error".into()
                } else {
                    "Agent crashed".into()
                },
                detail: truncate_chars(&payload.to_string(), MAX_DETAIL_CHARS),
                status: Some("failed".into()),
                parameters: Vec::new(),
                result: None,
            },
        ),
        "acp_read" => apply_acp_read(stream, seq, &at, &payload),
        "acp_write" => apply_acp_write(stream, seq, &at, &payload),
        // turn_liveness, control_result, lifecycle noise: freshness only.
        _ => {}
    }
}

fn apply_acp_read(stream: &mut AgentStream, seq: u64, at: &str, payload: &Value) {
    let method = payload.get("method").and_then(Value::as_str).unwrap_or("");
    match method {
        "session/update" => {
            let Some(update) = payload.pointer("/params/update") else {
                return;
            };
            apply_session_update(stream, seq, at, update);
        }
        "session/request_permission" => {
            let title = payload
                .pointer("/params/toolCall/title")
                .and_then(Value::as_str)
                .unwrap_or("Tool call");
            push_entry(
                stream,
                RichEntry {
                    id: format!("{seq}-permission"),
                    at: at.to_string(),
                    kind: "lifecycle".into(),
                    title: "Permission requested".into(),
                    detail: truncate_chars(title, MAX_DETAIL_CHARS),
                    status: Some("running".into()),
                    parameters: Vec::new(),
                    result: None,
                },
            );
        }
        _ => {}
    }
}

fn apply_acp_write(stream: &mut AgentStream, seq: u64, at: &str, payload: &Value) {
    let method = payload.get("method").and_then(Value::as_str).unwrap_or("");
    match method {
        "session/prompt" => {
            let text = payload
                .pointer("/params/prompt")
                .and_then(Value::as_array)
                .map(|blocks| collect_text_blocks(blocks))
                .unwrap_or_default();
            push_entry(
                stream,
                RichEntry {
                    id: format!("{seq}-prompt"),
                    at: at.to_string(),
                    kind: "message".into(),
                    title: "Prompt dispatched to agent".into(),
                    detail: truncate_chars(&text, MAX_DETAIL_CHARS),
                    status: Some("complete".into()),
                    parameters: Vec::new(),
                    result: None,
                },
            );
        }
        "session/cancel" => push_entry(
            stream,
            RichEntry {
                id: format!("{seq}-cancel"),
                at: at.to_string(),
                kind: "lifecycle".into(),
                title: "Turn cancel requested".into(),
                detail: String::new(),
                status: Some("complete".into()),
                parameters: Vec::new(),
                result: None,
            },
        ),
        _ => {}
    }
}

fn apply_session_update(stream: &mut AgentStream, seq: u64, at: &str, update: &Value) {
    let update_kind = update
        .get("sessionUpdate")
        .and_then(Value::as_str)
        .unwrap_or("");
    match update_kind {
        "agent_message_chunk" => {
            if let Some(text) = content_text(update.get("content")) {
                append_capped(&mut stream.live_text, &text, MAX_LIVE_TEXT_BYTES);
            }
        }
        "agent_thought_chunk" => {
            if let Some(text) = content_text(update.get("content")) {
                append_capped(&mut stream.live_thought, &text, MAX_THOUGHT_BYTES);
            }
        }
        "tool_call" => {
            let id = update
                .get("toolCallId")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| format!("{seq}-tool"));
            let title = update
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("Tool call");
            push_entry(
                stream,
                RichEntry {
                    id,
                    at: at.to_string(),
                    kind: "tool".into(),
                    title: truncate_chars(title, 200),
                    detail: String::new(),
                    status: Some(tool_status(update.get("status"))),
                    parameters: raw_input_parameters(update.get("rawInput")),
                    result: None,
                },
            );
        }
        "tool_call_update" => {
            let Some(id) = update.get("toolCallId").and_then(Value::as_str) else {
                return;
            };
            let Some(entry) = stream.entries.iter_mut().rev().find(|e| e.id == id) else {
                return;
            };
            if update.get("status").is_some() {
                entry.status = Some(tool_status(update.get("status")));
            }
            if let Some(title) = update.get("title").and_then(Value::as_str) {
                entry.title = truncate_chars(title, 200);
            }
            let output = update
                .get("content")
                .and_then(Value::as_array)
                .map(|blocks| tool_content_text(blocks))
                .filter(|text| !text.is_empty())
                .or_else(|| {
                    update
                        .get("rawOutput")
                        .filter(|v| !v.is_null())
                        .map(|v| v.to_string())
                });
            if let Some(output) = output {
                entry.result = Some(truncate_chars(&output, MAX_DETAIL_CHARS));
            }
        }
        "plan" => {
            let detail = update
                .get("entries")
                .and_then(Value::as_array)
                .map(|entries| {
                    entries
                        .iter()
                        .filter_map(|e| e.get("content").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join(" · ")
                })
                .unwrap_or_default();
            push_entry(
                stream,
                RichEntry {
                    id: format!("{seq}-plan"),
                    at: at.to_string(),
                    kind: "lifecycle".into(),
                    title: "Plan updated".into(),
                    detail: truncate_chars(&detail, MAX_DETAIL_CHARS),
                    status: Some("complete".into()),
                    parameters: Vec::new(),
                    result: None,
                },
            );
        }
        _ => {}
    }
}

fn push_entry(stream: &mut AgentStream, entry: RichEntry) {
    stream.entries.push(entry);
    if stream.entries.len() > MAX_ENTRIES_PER_AGENT {
        let excess = stream.entries.len() - MAX_ENTRIES_PER_AGENT;
        stream.entries.drain(..excess);
    }
}

fn tool_status(status: Option<&Value>) -> String {
    match status.and_then(Value::as_str) {
        Some("completed") => "complete".into(),
        Some("failed") => "failed".into(),
        _ => "running".into(),
    }
}

fn content_text(content: Option<&Value>) -> Option<String> {
    let content = content?;
    if let Some(text) = content.get("text").and_then(Value::as_str) {
        return Some(text.to_string());
    }
    None
}

fn collect_text_blocks(blocks: &[Value]) -> String {
    blocks
        .iter()
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("")
}

fn tool_content_text(blocks: &[Value]) -> String {
    blocks
        .iter()
        .filter_map(|block| {
            block
                .pointer("/content/text")
                .or_else(|| block.get("text"))
                .and_then(Value::as_str)
        })
        .collect::<Vec<_>>()
        .join("")
}

fn raw_input_parameters(raw_input: Option<&Value>) -> Vec<RichParameter> {
    let Some(raw_input) = raw_input else {
        return Vec::new();
    };
    match raw_input {
        Value::Object(map) => map
            .iter()
            .take(MAX_PARAMS)
            .map(|(key, value)| RichParameter {
                label: truncate_chars(key, 60),
                value: truncate_chars(&compact_value(value), MAX_PARAM_VALUE_CHARS),
            })
            .collect(),
        Value::Null => Vec::new(),
        other => vec![RichParameter {
            label: "input".into(),
            value: truncate_chars(&compact_value(other), MAX_PARAM_VALUE_CHARS),
        }],
    }
}

fn compact_value(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let truncated: String = text.chars().take(max_chars).collect();
    format!("{truncated}…")
}

/// Append `text`, keeping only the trailing `cap` bytes (char-boundary safe).
fn append_capped(buffer: &mut String, text: &str, cap: usize) {
    buffer.push_str(text);
    if buffer.len() > cap {
        let mut cut = buffer.len() - cap;
        while cut < buffer.len() && !buffer.is_char_boundary(cut) {
            cut += 1;
        }
        buffer.replace_range(..cut, "");
    }
}

// ---------------------------------------------------------------------------
// Relay subscription: connect, NIP-42 auth, REQ, decrypt, apply.
// ---------------------------------------------------------------------------

async fn run_stream(
    store: ObserverStreamStore,
    keys: Keys,
    relay_url: String,
    channels: Vec<String>,
    generation: u64,
) {
    let mut backoff = RECONNECT_MIN_SECS;
    while store.generation.load(Ordering::SeqCst) == generation {
        match connect_and_stream(&store, &keys, &relay_url, &channels, generation).await {
            Ok(()) => backoff = RECONNECT_MIN_SECS,
            Err(error) => {
                store.set_error(generation, error);
                backoff = (backoff * 2).min(RECONNECT_MAX_SECS);
            }
        }
        store.set_connected(generation, false);
        if store.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        tokio::time::sleep(Duration::from_secs(backoff)).await;
    }
}

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect_and_stream(
    store: &ObserverStreamStore,
    keys: &Keys,
    relay_url: &str,
    channels: &[String],
    generation: u64,
) -> Result<(), String> {
    let (mut ws, _) = tokio_tungstenite::connect_async(relay_url)
        .await
        .map_err(|error| format!("relay connect failed: {error}"))?;

    authenticate(&mut ws, keys, relay_url).await?;

    let mut req = vec![json!("REQ"), json!(SUBSCRIPTION_ID)];
    req.extend(subscription_filters(&keys.public_key().to_hex(), channels));
    send_json(&mut ws, &Value::Array(req)).await?;
    store.set_connected(generation, true);

    loop {
        if store.generation.load(Ordering::SeqCst) != generation {
            let _ = ws.close(None).await;
            return Ok(());
        }
        let message = match tokio::time::timeout(
            Duration::from_secs(READ_IDLE_TIMEOUT_SECS),
            ws.next(),
        )
        .await
        {
            Ok(Some(Ok(message))) => message,
            Ok(Some(Err(error))) => return Err(format!("relay read failed: {error}")),
            Ok(None) => return Err("relay closed the connection".into()),
            Err(_) => return Err("relay subscription idle timeout".into()),
        };
        match message {
            tokio_tungstenite::tungstenite::Message::Text(text) => {
                handle_relay_text(store, keys, generation, text.as_str());
            }
            tokio_tungstenite::tungstenite::Message::Ping(data) => {
                ws.send(tokio_tungstenite::tungstenite::Message::Pong(data))
                    .await
                    .map_err(|error| format!("relay pong failed: {error}"))?;
            }
            tokio_tungstenite::tungstenite::Message::Close(_) => {
                return Err("relay closed the connection".into());
            }
            _ => {}
        }
    }
}

async fn authenticate(ws: &mut WsStream, keys: &Keys, relay_url: &str) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(AUTH_TIMEOUT_SECS);
    let challenge = loop {
        let remaining = deadline
            .checked_duration_since(tokio::time::Instant::now())
            .ok_or_else(|| "relay did not send an AUTH challenge".to_string())?;
        let message = tokio::time::timeout(remaining, ws.next())
            .await
            .map_err(|_| "relay did not send an AUTH challenge".to_string())?
            .ok_or_else(|| "relay closed during auth".to_string())?
            .map_err(|error| format!("relay read failed during auth: {error}"))?;
        if let tokio_tungstenite::tungstenite::Message::Text(text) = message {
            let parsed: Value = serde_json::from_str(text.as_str())
                .map_err(|error| format!("invalid relay frame: {error}"))?;
            if parsed.get(0).and_then(Value::as_str) == Some("AUTH") {
                let challenge = parsed
                    .get(1)
                    .and_then(Value::as_str)
                    .ok_or_else(|| "malformed AUTH challenge".to_string())?;
                if challenge.len() > 1024 {
                    return Err("AUTH challenge exceeds 1024 bytes".into());
                }
                break challenge.to_string();
            }
        }
    };

    let url = RelayUrl::parse(relay_url).map_err(|error| format!("invalid relay URL: {error}"))?;
    let auth_event = EventBuilder::auth(&challenge, url)
        .sign_with_keys(keys)
        .map_err(|error| format!("failed to sign AUTH event: {error}"))?;
    let auth_id = auth_event.id.to_hex();
    send_json(ws, &json!(["AUTH", auth_event])).await?;

    let deadline = tokio::time::Instant::now() + Duration::from_secs(AUTH_TIMEOUT_SECS);
    loop {
        let remaining = deadline
            .checked_duration_since(tokio::time::Instant::now())
            .ok_or_else(|| "relay did not acknowledge AUTH".to_string())?;
        let message = tokio::time::timeout(remaining, ws.next())
            .await
            .map_err(|_| "relay did not acknowledge AUTH".to_string())?
            .ok_or_else(|| "relay closed during auth".to_string())?
            .map_err(|error| format!("relay read failed during auth: {error}"))?;
        if let tokio_tungstenite::tungstenite::Message::Text(text) = message {
            let parsed: Value = serde_json::from_str(text.as_str())
                .map_err(|error| format!("invalid relay frame: {error}"))?;
            if parsed.get(0).and_then(Value::as_str) == Some("OK")
                && parsed.get(1).and_then(Value::as_str) == Some(auth_id.as_str())
            {
                if parsed.get(2).and_then(Value::as_bool) == Some(true) {
                    return Ok(());
                }
                let reason = parsed.get(3).and_then(Value::as_str).unwrap_or("rejected");
                return Err(format!("relay rejected AUTH: {reason}"));
            }
        }
    }
}

async fn send_json(ws: &mut WsStream, value: &Value) -> Result<(), String> {
    let text = serde_json::to_string(value).map_err(|error| error.to_string())?;
    ws.send(tokio_tungstenite::tungstenite::Message::Text(text))
        .await
        .map_err(|error| format!("relay send failed: {error}"))
}

/// Two filters: owner-scoped kind-24200 frames route globally and are matched
/// by `#p` alone, while channel-scoped kind-24201 copies ride the relay's
/// channel fan-out index — a subscription only matches them when it names the
/// channel in `#h` (verified live against buzz.nilor.cool 2026-08-23).
fn subscription_filters(pubkey_hex: &str, channels: &[String]) -> Vec<Value> {
    let mut filters = vec![json!({
        "kinds": [OBSERVER_FRAME_KIND],
        "#p": [pubkey_hex],
    })];
    if !channels.is_empty() {
        filters.push(json!({
            "kinds": [SHARED_OBSERVER_FRAME_KIND],
            "#p": [pubkey_hex],
            "#h": channels,
        }));
    }
    filters
}

fn handle_relay_text(store: &ObserverStreamStore, keys: &Keys, generation: u64, text: &str) {
    let Ok(parsed) = serde_json::from_str::<Value>(text) else {
        return;
    };
    if parsed.get(0).and_then(Value::as_str) != Some("EVENT") {
        return;
    }
    let Some(event_value) = parsed.get(2) else {
        return;
    };
    let Ok(event) = serde_json::from_value::<Event>(event_value.clone()) else {
        return;
    };
    let kind = event.kind.as_u16();
    if kind != OBSERVER_FRAME_KIND && kind != SHARED_OBSERVER_FRAME_KIND {
        return;
    }
    if event.verify().is_err() {
        return;
    }
    let content_len = event.content.len();
    if !(NIP44_MIN_CONTENT_LEN..=NIP44_MAX_CONTENT_LEN).contains(&content_len) {
        return;
    }
    let Ok(plaintext) = nip44::decrypt(keys.secret_key(), &event.pubkey, &event.content) else {
        return;
    };
    if plaintext.len() > MAX_PLAINTEXT_BYTES {
        return;
    }
    let Ok(frame) = serde_json::from_str::<Value>(&plaintext) else {
        return;
    };
    let agent_pubkey = event
        .tags
        .iter()
        .find(|tag| tag.kind().to_string() == "agent")
        .and_then(|tag| tag.content())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| event.pubkey.to_hex());
    store.apply(generation, &agent_pubkey, &frame);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(seq: u64, kind: &str, payload: Value) -> Value {
        json!({
            "seq": seq,
            "timestamp": "2026-08-23T01:00:00Z",
            "kind": kind,
            "agent_index": 0,
            "channel_id": "0b7c0958-3f7f-48c8-af3f-31e549b10e31",
            "session_id": "session-1",
            "turn_id": "turn-1",
            "payload": payload,
        })
    }

    fn session_update(seq: u64, update: Value) -> Value {
        frame(
            seq,
            "acp_read",
            json!({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": { "sessionId": "session-1", "update": update },
            }),
        )
    }

    fn stream<'a>(inner: &'a StoreInner, agent: &str) -> &'a AgentStream {
        inner.agents.get(agent).expect("agent stream exists")
    }

    #[test]
    fn message_chunks_accumulate_and_turn_start_resets() {
        let mut inner = StoreInner::default();
        apply_frame(
            &mut inner,
            "agent-a",
            &session_update(
                1,
                json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "Hello " } }),
            ),
        );
        apply_frame(
            &mut inner,
            "agent-a",
            &session_update(
                2,
                json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "world" } }),
            ),
        );
        assert_eq!(stream(&inner, "agent-a").live_text, "Hello world");

        apply_frame(&mut inner, "agent-a", &frame(3, "turn_started", json!({})));
        assert_eq!(stream(&inner, "agent-a").live_text, "");
        assert_eq!(stream(&inner, "agent-a").entries.len(), 1);
        assert_eq!(stream(&inner, "agent-a").entries[0].title, "Turn started");
    }

    #[test]
    fn tool_call_update_joins_by_tool_call_id() {
        let mut inner = StoreInner::default();
        apply_frame(
            &mut inner,
            "agent-a",
            &session_update(
                1,
                json!({
                    "sessionUpdate": "tool_call",
                    "toolCallId": "call-9",
                    "title": "Read file",
                    "status": "in_progress",
                    "rawInput": { "path": "/tmp/x", "mode": "full" },
                }),
            ),
        );
        apply_frame(
            &mut inner,
            "agent-a",
            &session_update(
                2,
                json!({
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "call-9",
                    "status": "completed",
                    "content": [{ "type": "content", "content": { "type": "text", "text": "42 lines" } }],
                }),
            ),
        );
        let entries = &stream(&inner, "agent-a").entries;
        assert_eq!(entries.len(), 1, "update mutates the existing entry");
        assert_eq!(entries[0].status.as_deref(), Some("complete"));
        assert_eq!(entries[0].result.as_deref(), Some("42 lines"));
        assert_eq!(entries[0].parameters.len(), 2);
    }

    #[test]
    fn batch_frames_expand_to_inner_events() {
        let mut inner = StoreInner::default();
        let batch = json!({
            "seq": 5,
            "timestamp": "2026-08-23T01:00:00Z",
            "kind": "batch",
            "channel_id": "chan",
            "payload": { "events": [
                frame(3, "turn_started", json!({})),
                session_update(4, json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "hi" } })),
            ]},
        });
        apply_frame(&mut inner, "agent-a", &batch);
        assert_eq!(stream(&inner, "agent-a").entries.len(), 1);
        assert_eq!(stream(&inner, "agent-a").live_text, "hi");
    }

    #[test]
    fn live_text_keeps_tail_when_capped() {
        let mut buffer = String::new();
        append_capped(
            &mut buffer,
            &"a".repeat(MAX_LIVE_TEXT_BYTES),
            MAX_LIVE_TEXT_BYTES,
        );
        append_capped(&mut buffer, "TAIL", MAX_LIVE_TEXT_BYTES);
        assert_eq!(buffer.len(), MAX_LIVE_TEXT_BYTES);
        assert!(buffer.ends_with("TAIL"));
    }

    #[test]
    fn entry_ring_buffer_drops_oldest() {
        let mut inner = StoreInner::default();
        for seq in 0..(MAX_ENTRIES_PER_AGENT + 10) as u64 {
            apply_frame(
                &mut inner,
                "agent-a",
                &frame(seq, "turn_completed", json!({})),
            );
        }
        let entries = &stream(&inner, "agent-a").entries;
        assert_eq!(entries.len(), MAX_ENTRIES_PER_AGENT);
        assert_eq!(entries[0].id, "10-turn-completed");
    }

    #[test]
    fn prompt_write_frames_render_as_message_entries() {
        let mut inner = StoreInner::default();
        apply_frame(
            &mut inner,
            "agent-a",
            &frame(
                1,
                "acp_write",
                json!({
                    "jsonrpc": "2.0",
                    "method": "session/prompt",
                    "params": { "prompt": [{ "type": "text", "text": "fix the bug" }] },
                }),
            ),
        );
        let entries = &stream(&inner, "agent-a").entries;
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].kind, "message");
        assert_eq!(entries[0].detail, "fix the bug");
    }

    #[test]
    fn subscription_filters_split_owner_and_channel_lanes() {
        let filters = subscription_filters("ab".repeat(32).as_str(), &["chan-1".to_string()]);
        assert_eq!(filters.len(), 2);
        assert_eq!(filters[0]["kinds"][0], OBSERVER_FRAME_KIND);
        assert!(
            filters[0].get("#h").is_none(),
            "24200 frames carry no h tag"
        );
        assert_eq!(filters[1]["kinds"][0], SHARED_OBSERVER_FRAME_KIND);
        assert_eq!(filters[1]["#h"][0], "chan-1");
        assert_eq!(filters[1]["#p"][0], filters[0]["#p"][0]);

        let no_channels = subscription_filters("ab", &[]);
        assert_eq!(no_channels.len(), 1, "no channel filter without channels");
    }

    #[test]
    fn snapshot_orders_entries_newest_first() {
        let store = ObserverStreamStore::default();
        {
            let mut inner = store.inner.lock().unwrap();
            inner.relay_url = "wss://example".into();
            apply_frame(&mut inner, "agent-a", &frame(1, "turn_started", json!({})));
            apply_frame(
                &mut inner,
                "agent-a",
                &frame(2, "turn_completed", json!({})),
            );
        }
        let page = store.snapshot().unwrap();
        assert_eq!(page.agents.len(), 1);
        assert_eq!(page.agents[0].stream.entries[0].title, "Turn completed");
        assert_eq!(page.agents[0].stream.entries[1].title, "Turn started");
    }
}
