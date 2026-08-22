//! Agent work-status telemetry over the relay's signed read-only query
//! surface.
//!
//! Buzz agents publish their live turn status as NIP-38 kind:30315 events
//! with `d` = channel UUID (stored globally on the relay — queried by `#d`,
//! not `#h`), replaceable per (author, d) so only the latest snapshot per
//! agent per channel survives. The content is a small JSON document marked
//! with `v == 1` and `source == "buzz-acp"`; anything else carrying the same
//! kind and `d` tag (e.g. a human's own status) is silently ignored.

use nostr::Event;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::channel_directory::tag_value;
use crate::relay_activity::post_signed_query;

const TELEMETRY_KIND: u16 = 30_315;
const TELEMETRY_SOURCE: &str = "buzz-acp";
const MAX_CONTENT_BYTES: usize = 16_384;
const MAX_ACTIVITY_ENTRIES: usize = 20;
const MAX_TITLE_CHARS: usize = 160;
const MAX_EVENTS_QUERIED: usize = 100;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryActivityEntry {
    pub at: Option<String>,
    pub kind: Option<String>,
    pub title: Option<String>,
    pub status: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentTelemetry {
    pub pubkey: String,
    pub event_created_at: u64,
    pub status: String,
    pub model: Option<String>,
    pub session_id: Option<String>,
    pub turn_id: Option<String>,
    pub turn_started_at: Option<String>,
    pub updated_at: Option<String>,
    pub completed_at: Option<String>,
    pub stop_reason: Option<String>,
    pub activity: Vec<TelemetryActivityEntry>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayTelemetryPage {
    pub channel_id: String,
    pub statuses: Vec<AgentTelemetry>,
}

/// The wire schema of a telemetry snapshot. Every field except `v` and
/// `status` is optional; unknown fields are ignored (serde default).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TelemetryContent {
    #[serde(default)]
    v: Option<u64>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    turn_id: Option<String>,
    #[serde(default)]
    turn_started_at: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    completed_at: Option<String>,
    #[serde(default)]
    stop_reason: Option<String>,
    #[serde(default)]
    activity: Vec<TelemetryContentActivity>,
}

#[derive(Debug, Deserialize)]
struct TelemetryContentActivity {
    #[serde(default)]
    at: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    status: Option<String>,
}

fn is_known_status(status: &str) -> bool {
    matches!(status, "working" | "complete" | "error" | "idle")
}

fn bounded_title(value: Option<String>) -> Option<String> {
    value.map(|title| title.chars().take(MAX_TITLE_CHARS).collect())
}

/// Validate one relay event as an agent telemetry snapshot for this channel
/// and roster. Returns `None` for anything that is not telemetry — invalid
/// signatures, wrong kind or `d` tag, authors outside the roster, oversized
/// or unparseable content, and content missing the `v`/`source`/`status`
/// telemetry markers are all skipped silently, never errors.
pub(crate) fn parse_telemetry(
    event: &Event,
    channel_id: &str,
    author_pubkeys: &[String],
) -> Option<AgentTelemetry> {
    if event.kind.as_u16() != TELEMETRY_KIND || !event.verify_id() || !event.verify_signature() {
        return None;
    }
    if tag_value(event, "d") != Some(channel_id) {
        return None;
    }
    let pubkey = event.pubkey.to_hex();
    if !author_pubkeys
        .iter()
        .any(|author| author.eq_ignore_ascii_case(&pubkey))
    {
        return None;
    }
    if event.content.len() > MAX_CONTENT_BYTES {
        return None;
    }
    let content: TelemetryContent = serde_json::from_str(&event.content).ok()?;
    if content.v != Some(1) || content.source.as_deref() != Some(TELEMETRY_SOURCE) {
        return None;
    }
    let status = content.status?;
    if !is_known_status(&status) {
        return None;
    }

    // Activity is newest-last; keep the newest entries when over the cap.
    let overflow = content.activity.len().saturating_sub(MAX_ACTIVITY_ENTRIES);
    let activity = content
        .activity
        .into_iter()
        .skip(overflow)
        .map(|entry| TelemetryActivityEntry {
            at: entry.at,
            kind: entry.kind,
            title: bounded_title(entry.title),
            status: entry.status,
        })
        .collect();

    Some(AgentTelemetry {
        pubkey,
        event_created_at: event.created_at.as_secs(),
        status,
        model: content.model,
        session_id: content.session_id,
        turn_id: content.turn_id,
        turn_started_at: content.turn_started_at,
        updated_at: content.updated_at,
        completed_at: content.completed_at,
        stop_reason: content.stop_reason,
        activity,
    })
}

/// Reduce a page of relay events to at most one telemetry snapshot per
/// roster member. The kind is replaceable per (author, d) so the relay
/// should already return one event per agent, but a duplicate is resolved
/// deterministically by keeping the newest `created_at`.
pub(crate) fn collect_statuses(
    events: &[Event],
    channel_id: &str,
    author_pubkeys: &[String],
) -> Vec<AgentTelemetry> {
    let mut statuses: Vec<AgentTelemetry> = Vec::new();
    for event in events {
        let Some(telemetry) = parse_telemetry(event, channel_id, author_pubkeys) else {
            continue;
        };
        match statuses
            .iter_mut()
            .find(|existing| existing.pubkey == telemetry.pubkey)
        {
            Some(existing) => {
                if telemetry.event_created_at > existing.event_created_at {
                    *existing = telemetry;
                }
            }
            None => statuses.push(telemetry),
        }
    }
    statuses
}

/// Load the latest agent work-status snapshots for a channel, restricted to
/// the discovered roster. Hard-errors only on transport failures; individual
/// non-telemetry events are skipped.
pub async fn load_channel_telemetry(
    device_keys: &nostr::Keys,
    relay_url: &str,
    channel_id: &str,
    author_pubkeys: &[String],
) -> Result<RelayTelemetryPage, String> {
    Uuid::parse_str(channel_id).map_err(|_| "channel id must be a UUID".to_string())?;
    let filters = serde_json::json!([
        { "kinds": [TELEMETRY_KIND], "#d": [channel_id], "limit": MAX_EVENTS_QUERIED },
    ]);
    let events = post_signed_query(device_keys, relay_url, &filters).await?;
    Ok(RelayTelemetryPage {
        channel_id: channel_id.to_string(),
        statuses: collect_statuses(&events, channel_id, author_pubkeys),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};

    const CHANNEL: &str = "0b7c0958-3f7f-48c8-af3f-31e549b10e31";

    fn telemetry_event(keys: &Keys, channel_id: &str, content: &str) -> Event {
        EventBuilder::new(Kind::Custom(TELEMETRY_KIND), content)
            .tags([Tag::parse(["d", channel_id]).expect("d tag")])
            .sign_with_keys(keys)
            .expect("signed telemetry event")
    }

    fn roster(keys: &Keys) -> Vec<String> {
        vec![keys.public_key().to_hex()]
    }

    #[test]
    fn parses_a_valid_snapshot() {
        let keys = Keys::generate();
        let content = r#"{
            "v": 1,
            "source": "buzz-acp",
            "status": "working",
            "model": "opencode/gpt-5.6-sol",
            "sessionId": "session-1",
            "turnId": "turn-1",
            "turnStartedAt": "2026-08-22T19:00:00Z",
            "updatedAt": "2026-08-22T19:00:10Z",
            "completedAt": null,
            "stopReason": null,
            "futureField": {"ignored": true},
            "activity": [
                {"at": "2026-08-22T19:00:05Z", "kind": "tool", "title": "Shell command", "status": "complete"},
                {"at": "2026-08-22T19:00:08Z", "kind": "message", "title": "Streaming reply", "status": "running"}
            ]
        }"#;
        let event = telemetry_event(&keys, CHANNEL, content);
        let telemetry = parse_telemetry(&event, CHANNEL, &roster(&keys)).expect("telemetry");

        assert_eq!(telemetry.pubkey, keys.public_key().to_hex());
        assert_eq!(telemetry.status, "working");
        assert_eq!(telemetry.model.as_deref(), Some("opencode/gpt-5.6-sol"));
        assert_eq!(telemetry.session_id.as_deref(), Some("session-1"));
        assert_eq!(telemetry.turn_id.as_deref(), Some("turn-1"));
        assert_eq!(
            telemetry.turn_started_at.as_deref(),
            Some("2026-08-22T19:00:00Z")
        );
        assert_eq!(telemetry.updated_at.as_deref(), Some("2026-08-22T19:00:10Z"));
        assert_eq!(telemetry.completed_at, None);
        assert_eq!(telemetry.stop_reason, None);
        assert_eq!(telemetry.activity.len(), 2);
        assert_eq!(telemetry.activity[1].title.as_deref(), Some("Streaming reply"));
        assert_eq!(telemetry.activity[1].status.as_deref(), Some("running"));
    }

    #[test]
    fn skips_non_telemetry_and_malformed_content() {
        let keys = Keys::generate();
        let authors = roster(&keys);
        // A human's own kind-30315 status with the same d tag.
        let human_status = telemetry_event(&keys, CHANNEL, r#"{"status": "on vacation"}"#);
        assert!(parse_telemetry(&human_status, CHANNEL, &authors).is_none());
        // Wrong source marker.
        let foreign_source = telemetry_event(
            &keys,
            CHANNEL,
            r#"{"v": 1, "source": "other-tool", "status": "working"}"#,
        );
        assert!(parse_telemetry(&foreign_source, CHANNEL, &authors).is_none());
        // Wrong version.
        let wrong_version = telemetry_event(
            &keys,
            CHANNEL,
            r#"{"v": 2, "source": "buzz-acp", "status": "working"}"#,
        );
        assert!(parse_telemetry(&wrong_version, CHANNEL, &authors).is_none());
        // Unknown status string.
        let unknown_status = telemetry_event(
            &keys,
            CHANNEL,
            r#"{"v": 1, "source": "buzz-acp", "status": "meditating"}"#,
        );
        assert!(parse_telemetry(&unknown_status, CHANNEL, &authors).is_none());
        // Not JSON at all.
        let not_json = telemetry_event(&keys, CHANNEL, "not-json");
        assert!(parse_telemetry(&not_json, CHANNEL, &authors).is_none());
        // Wrong d tag.
        let wrong_channel = telemetry_event(
            &keys,
            "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            r#"{"v": 1, "source": "buzz-acp", "status": "working"}"#,
        );
        assert!(parse_telemetry(&wrong_channel, CHANNEL, &authors).is_none());
    }

    #[test]
    fn skips_oversized_content() {
        let keys = Keys::generate();
        let padding = "x".repeat(MAX_CONTENT_BYTES);
        let content = format!(
            r#"{{"v": 1, "source": "buzz-acp", "status": "working", "model": "{padding}"}}"#
        );
        let event = telemetry_event(&keys, CHANNEL, &content);
        assert!(parse_telemetry(&event, CHANNEL, &roster(&keys)).is_none());
    }

    #[test]
    fn rejects_authors_outside_the_roster() {
        let agent = Keys::generate();
        let stranger = Keys::generate();
        let content = r#"{"v": 1, "source": "buzz-acp", "status": "working"}"#;
        let event = telemetry_event(&stranger, CHANNEL, content);
        assert!(parse_telemetry(&event, CHANNEL, &roster(&agent)).is_none());
        assert!(parse_telemetry(&event, CHANNEL, &roster(&stranger)).is_some());
    }

    #[test]
    fn caps_activity_entries_and_title_length() {
        let keys = Keys::generate();
        let long_title = "t".repeat(400);
        let entries: Vec<String> = (0..25)
            .map(|index| format!(r#"{{"kind": "tool", "title": "step-{index} {long_title}"}}"#))
            .collect();
        let content = format!(
            r#"{{"v": 1, "source": "buzz-acp", "status": "working", "activity": [{}]}}"#,
            entries.join(",")
        );
        let event = telemetry_event(&keys, CHANNEL, &content);
        let telemetry = parse_telemetry(&event, CHANNEL, &roster(&keys)).expect("telemetry");

        assert_eq!(telemetry.activity.len(), MAX_ACTIVITY_ENTRIES);
        // Newest-last entries survive the cap: the first five are dropped.
        assert!(telemetry.activity[0]
            .title
            .as_deref()
            .expect("title")
            .starts_with("step-5 "));
        for entry in &telemetry.activity {
            assert_eq!(entry.title.as_deref().expect("title").chars().count(), MAX_TITLE_CHARS);
        }
    }

    #[test]
    fn keeps_the_newest_snapshot_per_author() {
        let keys = Keys::generate();
        let authors = roster(&keys);
        let older = EventBuilder::new(
            Kind::Custom(TELEMETRY_KIND),
            r#"{"v": 1, "source": "buzz-acp", "status": "working"}"#,
        )
        .tags([Tag::parse(["d", CHANNEL]).expect("d tag")])
        .custom_created_at(Timestamp::from(1_800_000_000))
        .sign_with_keys(&keys)
        .expect("older event");
        let newer = EventBuilder::new(
            Kind::Custom(TELEMETRY_KIND),
            r#"{"v": 1, "source": "buzz-acp", "status": "complete"}"#,
        )
        .tags([Tag::parse(["d", CHANNEL]).expect("d tag")])
        .custom_created_at(Timestamp::from(1_800_000_100))
        .sign_with_keys(&keys)
        .expect("newer event");

        let statuses = collect_statuses(&[newer.clone(), older.clone()], CHANNEL, &authors);
        assert_eq!(statuses.len(), 1);
        assert_eq!(statuses[0].status, "complete");
        let statuses = collect_statuses(&[older, newer], CHANNEL, &authors);
        assert_eq!(statuses.len(), 1);
        assert_eq!(statuses[0].status, "complete");
    }
}
