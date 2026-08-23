//! Deterministic channel and agent discovery over the relay's signed
//! read-only query surface.
//!
//! Everything here is plain protocol data — no agent judgment anywhere:
//! - kind:39000 (`#d` = channel id): channel name and description
//! - kind:39002 (`#d` = channel id): the member roster; each `p` tag carries
//!   the member pubkey and its role (`owner`/`admin`/`member`/`bot`)
//! - kind:10100: relay-registered agent profiles (authored by the agent)
//! - kind:0: display names for the discovered members
//!
//! The same device identity that reads channel activity signs these queries,
//! so "the agents you have access to" is exactly what the relay authorizes
//! the admitted device key to see.

use nostr::Event;
use serde::Serialize;
use uuid::Uuid;

use crate::relay_activity::post_signed_query;

const MAX_DIRECTORY_MEMBERS: usize = 100;
const MAX_CHANNELS_LISTED: usize = 100;
const MAX_NAME_CHARS: usize = 120;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChannelSummary {
    pub id: String,
    pub name: String,
    pub description: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryMember {
    pub pubkey: String,
    pub name: Option<String>,
    pub role: String,
    pub is_agent: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelDirectory {
    pub channel_id: String,
    pub name: String,
    pub description: String,
    pub members: Vec<DirectoryMember>,
}

fn is_hex_pubkey(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn bounded_name(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(MAX_NAME_CHARS).collect())
}

pub(crate) fn tag_value<'a>(event: &'a Event, key: &str) -> Option<&'a str> {
    event.tags.iter().find_map(|tag| {
        let fields = tag.as_slice();
        if fields.first().is_some_and(|field| field == key) {
            fields.get(1).map(|value| value.as_str())
        } else {
            None
        }
    })
}

fn verified(event: &Event, kind: u16) -> bool {
    event.kind.as_u16() == kind && event.verify_id() && event.verify_signature()
}

/// Parse a kind:39000 channel-metadata event into a bounded summary.
pub(crate) fn parse_channel_summary(event: &Event) -> Option<ChannelSummary> {
    if !verified(event, 39_000) {
        return None;
    }
    let id = tag_value(event, "d")?;
    Uuid::parse_str(id).ok()?;
    Some(ChannelSummary {
        id: id.to_string(),
        name: bounded_name(tag_value(event, "name").unwrap_or_default())
            .unwrap_or_else(|| id.chars().take(8).collect()),
        description: bounded_name(tag_value(event, "about").unwrap_or_default())
            .unwrap_or_default(),
    })
}

/// Parse the kind:39002 roster into `(pubkey, role)` pairs. The role sits in
/// the fourth `p`-tag field; a missing role defaults to `member`.
pub(crate) fn parse_member_roles(event: &Event, channel_id: &str) -> Vec<(String, String)> {
    if !verified(event, 39_002) || tag_value(event, "d") != Some(channel_id) {
        return Vec::new();
    }
    let mut members = Vec::new();
    let mut seen = Vec::new();
    for tag in event.tags.iter() {
        let fields = tag.as_slice();
        if fields.first().is_none_or(|field| field != "p") {
            continue;
        }
        let Some(pubkey) = fields.get(1).map(|value| value.as_str()) else {
            continue;
        };
        if !is_hex_pubkey(pubkey) || seen.contains(&pubkey) {
            continue;
        }
        seen.push(pubkey);
        let role = fields
            .get(3)
            .map(|value| value.as_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("member");
        members.push((pubkey.to_lowercase(), role.chars().take(24).collect()));
        if members.len() >= MAX_DIRECTORY_MEMBERS {
            break;
        }
    }
    members
}

fn profile_display_name(event: &Event) -> Option<String> {
    let content: serde_json::Value = serde_json::from_str(&event.content).ok()?;
    let name = content
        .get("display_name")
        .and_then(|value| value.as_str())
        .or_else(|| content.get("name").and_then(|value| value.as_str()))?;
    bounded_name(name)
}

/// List the channels the relay makes visible to this device identity.
pub async fn list_channels(
    device_keys: &nostr::Keys,
    relay_url: &str,
) -> Result<Vec<ChannelSummary>, String> {
    let filters = serde_json::json!([{ "kinds": [39_000], "limit": MAX_CHANNELS_LISTED }]);
    let events = post_signed_query(device_keys, relay_url, &filters).await?;
    let mut channels: Vec<ChannelSummary> = Vec::new();
    for event in &events {
        // DM threads are modelled as channels too (`t` = "dm"); onboarding
        // only offers real channels.
        if tag_value(event, "t") == Some("dm") {
            continue;
        }
        if let Some(summary) = parse_channel_summary(event) {
            if !channels.iter().any(|existing| existing.id == summary.id) {
                channels.push(summary);
            }
        }
    }
    channels.sort_by_key(|channel| channel.name.to_lowercase());
    Ok(channels)
}

/// Discover a channel's roster: every member the device is authorized to see,
/// with its role, display name, and whether it is an agent (roster role `bot`
/// or a relay-registered kind:10100 agent profile).
pub async fn discover_channel(
    device_keys: &nostr::Keys,
    relay_url: &str,
    channel_id: &str,
) -> Result<ChannelDirectory, String> {
    Uuid::parse_str(channel_id).map_err(|_| "channel id must be a UUID".to_string())?;
    let filters = serde_json::json!([
        { "kinds": [39_000], "#d": [channel_id], "limit": 1 },
        { "kinds": [39_002], "#d": [channel_id], "limit": 1 },
        { "kinds": [10_100], "limit": 200 },
    ]);
    let events = post_signed_query(device_keys, relay_url, &filters).await?;

    let summary = events
        .iter()
        .filter(|event| tag_value(event, "d") == Some(channel_id))
        .find_map(parse_channel_summary);
    let members = events
        .iter()
        .find_map(|event| {
            let parsed = parse_member_roles(event, channel_id);
            if parsed.is_empty() {
                None
            } else {
                Some(parsed)
            }
        })
        .unwrap_or_default();
    if members.is_empty() {
        return Err("the relay returned no member roster for this channel".to_string());
    }

    let mut agent_pubkeys: Vec<String> = Vec::new();
    let mut agent_names: Vec<(String, String)> = Vec::new();
    for event in &events {
        if !verified(event, 10_100) {
            continue;
        }
        let pubkey = event.pubkey.to_hex();
        if !agent_pubkeys.contains(&pubkey) {
            if let Some(name) = profile_display_name(event) {
                agent_names.push((pubkey.clone(), name));
            }
            agent_pubkeys.push(pubkey);
        }
    }

    let member_pubkeys: Vec<String> = members.iter().map(|(pubkey, _)| pubkey.clone()).collect();
    let profile_filters = serde_json::json!([
        { "kinds": [0], "authors": member_pubkeys, "limit": MAX_DIRECTORY_MEMBERS },
    ]);
    let profile_events = post_signed_query(device_keys, relay_url, &profile_filters).await?;
    let mut profile_names: Vec<(String, String)> = Vec::new();
    for event in &profile_events {
        if !verified(event, 0) {
            continue;
        }
        let pubkey = event.pubkey.to_hex();
        if member_pubkeys.contains(&pubkey)
            && !profile_names
                .iter()
                .any(|(existing, _)| *existing == pubkey)
        {
            if let Some(name) = profile_display_name(event) {
                profile_names.push((pubkey, name));
            }
        }
    }

    let lookup = |table: &[(String, String)], pubkey: &str| {
        table
            .iter()
            .find(|(candidate, _)| candidate == pubkey)
            .map(|(_, name)| name.clone())
    };
    let members = members
        .into_iter()
        .map(|(pubkey, role)| {
            let is_agent = role == "bot" || agent_pubkeys.contains(&pubkey);
            let name = lookup(&profile_names, &pubkey).or_else(|| lookup(&agent_names, &pubkey));
            DirectoryMember {
                pubkey,
                name,
                role,
                is_agent,
            }
        })
        .collect();

    let (name, description) = summary
        .map(|summary| (summary.name, summary.description))
        .unwrap_or_else(|| (channel_id.chars().take(8).collect(), String::new()));
    Ok(ChannelDirectory {
        channel_id: channel_id.to_string(),
        name,
        description,
        members,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag};

    const CHANNEL: &str = "0b7c0958-3f7f-48c8-af3f-31e549b10e31";

    fn signed(keys: &Keys, kind: u16, tags: Vec<Vec<String>>, content: &str) -> Event {
        EventBuilder::new(Kind::Custom(kind), content)
            .tags(
                tags.iter()
                    .map(|tag| Tag::parse(tag.iter().map(String::as_str)).expect("tag")),
            )
            .sign_with_keys(keys)
            .expect("signed event")
    }

    #[test]
    fn parses_channel_summary_from_39000() {
        let keys = Keys::generate();
        let event = signed(
            &keys,
            39_000,
            vec![
                vec!["d".into(), CHANNEL.into()],
                vec!["name".into(), "buzz-control-tower".into()],
                vec!["about".into(), "Observability companion".into()],
            ],
            "",
        );
        let summary = parse_channel_summary(&event).expect("summary");
        assert_eq!(summary.id, CHANNEL);
        assert_eq!(summary.name, "buzz-control-tower");
        assert_eq!(summary.description, "Observability companion");
    }

    #[test]
    fn rejects_non_uuid_and_wrong_kind_summaries() {
        let keys = Keys::generate();
        let bad_id = signed(
            &keys,
            39_000,
            vec![vec!["d".into(), "not-a-uuid".into()]],
            "",
        );
        assert!(parse_channel_summary(&bad_id).is_none());
        let wrong_kind = signed(&keys, 39_002, vec![vec!["d".into(), CHANNEL.into()]], "");
        assert!(parse_channel_summary(&wrong_kind).is_none());
    }

    #[test]
    fn parses_member_roles_with_bot_default_and_dedupe() {
        let keys = Keys::generate();
        let agent = Keys::generate().public_key().to_hex();
        let human = Keys::generate().public_key().to_hex();
        let event = signed(
            &keys,
            39_002,
            vec![
                vec!["d".into(), CHANNEL.into()],
                vec!["p".into(), agent.clone(), "".into(), "bot".into()],
                vec!["p".into(), human.clone()],
                vec!["p".into(), human.clone(), "".into(), "member".into()],
                vec!["p".into(), "not-a-pubkey".into()],
            ],
            "",
        );
        let members = parse_member_roles(&event, CHANNEL);
        assert_eq!(members.len(), 2);
        assert_eq!(members[0], (agent, "bot".to_string()));
        assert_eq!(members[1], (human, "member".to_string()));
        assert!(parse_member_roles(&event, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa").is_empty());
    }

    #[test]
    fn reads_display_name_from_profile_content() {
        let keys = Keys::generate();
        let event = signed(
            &keys,
            0,
            vec![],
            r#"{"display_name":"Lucas-Fizz","picture":"x"}"#,
        );
        assert_eq!(profile_display_name(&event), Some("Lucas-Fizz".to_string()));
        let fallback = signed(&keys, 0, vec![], r#"{"name":"thor-mos-psc"}"#);
        assert_eq!(
            profile_display_name(&fallback),
            Some("thor-mos-psc".to_string())
        );
        let invalid = signed(&keys, 0, vec![], "not-json");
        assert_eq!(profile_display_name(&invalid), None);
    }
}
