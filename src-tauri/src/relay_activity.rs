use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use nostr::{Event, EventBuilder, JsonUtil, Kind, PublicKey, Tag};
use reqwest::Url;
use serde::Serialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

const MAX_AUTHORS: usize = 50;
const MAX_LIMIT: u32 = 200;
const MAX_MESSAGE_BYTES: usize = 65_535;
const MAX_RESPONSE_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RelayMessage {
    pub id: String,
    pub pubkey: String,
    pub kind: u16,
    pub created_at: u64,
    pub content: String,
    pub reply_to: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayActivityPage {
    pub relay_url: String,
    pub channel_id: String,
    pub device_pubkey: String,
    pub messages: Vec<RelayMessage>,
}

pub(crate) fn http_query_url(relay_url: &str) -> Result<String, String> {
    let mut parsed =
        Url::parse(relay_url.trim()).map_err(|error| format!("invalid relay URL: {error}"))?;
    match parsed.scheme() {
        "wss" => parsed
            .set_scheme("https")
            .map_err(|_| "invalid relay URL scheme".to_string())?,
        "ws" => parsed
            .set_scheme("http")
            .map_err(|_| "invalid relay URL scheme".to_string())?,
        _ => return Err("relay URL must use ws or wss".to_string()),
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("relay URL must not contain credentials".to_string());
    }
    if parsed.fragment().is_some() {
        return Err("relay URL must not contain a fragment".to_string());
    }
    if parsed.query().is_some() {
        return Err("relay URL must not contain a query".to_string());
    }
    if parsed.host_str().is_none() {
        return Err("relay URL must contain a host".to_string());
    }

    let base = parsed.as_str().trim_end_matches('/');
    Ok(format!("{base}/query"))
}

fn sign_nip98(keys: &nostr::Keys, url: &str, body: &[u8]) -> Result<String, String> {
    let payload_hash = hex::encode(Sha256::digest(body));
    let tags = [
        Tag::parse(["u", url]).map_err(|error| format!("build auth URL tag: {error}"))?,
        Tag::parse(["method", "POST"])
            .map_err(|error| format!("build auth method tag: {error}"))?,
        Tag::parse(["nonce", Uuid::new_v4().to_string().as_str()])
            .map_err(|error| format!("build auth nonce tag: {error}"))?,
        Tag::parse(["payload", payload_hash.as_str()])
            .map_err(|error| format!("build auth payload tag: {error}"))?,
    ];
    let event = EventBuilder::new(Kind::Custom(27_235), "")
        .tags(tags)
        .sign_with_keys(keys)
        .map_err(|error| format!("sign relay request: {error}"))?;
    Ok(format!("Nostr {}", BASE64.encode(event.as_json())))
}

fn single_channel_tag(event: &Event) -> Option<&str> {
    let mut tags = event
        .tags
        .iter()
        .filter(|tag| tag.as_slice().first().is_some_and(|value| value == "h"));
    let fields = tags.next()?.as_slice();
    if fields.len() != 2 || tags.next().is_some() {
        return None;
    }
    Some(fields[1].as_str())
}

fn reply_target(event: &Event) -> Option<String> {
    let mut fallback = None;
    for tag in event.tags.iter() {
        let fields = tag.as_slice();
        if fields.first().is_none_or(|value| value != "e") || fields.len() < 2 {
            continue;
        }
        let candidate = fields[1].as_str();
        if candidate.len() != 64 || !candidate.chars().all(|char| char.is_ascii_hexdigit()) {
            continue;
        }
        if fields.get(3).is_some_and(|value| value == "reply") {
            return Some(candidate.to_string());
        }
        fallback.get_or_insert_with(|| candidate.to_string());
    }
    fallback
}

fn validate_messages(
    events: Vec<Event>,
    channel_id: &str,
    authors: &[PublicKey],
) -> Result<Vec<RelayMessage>, String> {
    let mut messages = Vec::with_capacity(events.len());
    for event in events {
        if !event.verify_id() || !event.verify_signature() {
            return Err("relay returned an event with an invalid signature".to_string());
        }
        if !matches!(event.kind.as_u16(), 9 | 40_002 | 40_003 | 40_008) {
            return Err("relay returned an event outside the requested message kinds".to_string());
        }
        if single_channel_tag(&event) != Some(channel_id) {
            return Err("relay returned an event outside the requested channel".to_string());
        }
        if !authors.contains(&event.pubkey) {
            return Err("relay returned an event outside the requested authors".to_string());
        }
        if event.content.len() > MAX_MESSAGE_BYTES {
            return Err("relay returned an oversized message".to_string());
        }

        messages.push(RelayMessage {
            id: event.id.to_hex(),
            pubkey: event.pubkey.to_hex(),
            kind: event.kind.as_u16(),
            created_at: event.created_at.as_secs(),
            reply_to: reply_target(&event),
            content: event.content,
        });
    }
    messages.sort_by_key(|message| (message.created_at, message.id.clone()));
    Ok(messages)
}

pub async fn load_channel_activity(
    device_keys: &nostr::Keys,
    relay_url: &str,
    channel_id: &str,
    author_pubkeys: &[String],
    since: Option<u64>,
    limit: Option<u32>,
) -> Result<RelayActivityPage, String> {
    Uuid::parse_str(channel_id).map_err(|_| "channel id must be a UUID".to_string())?;
    if author_pubkeys.is_empty() || author_pubkeys.len() > MAX_AUTHORS {
        return Err(format!(
            "author list must contain 1 to {MAX_AUTHORS} pubkeys"
        ));
    }
    let authors = author_pubkeys
        .iter()
        .map(|value| PublicKey::parse(value).map_err(|_| format!("invalid author pubkey: {value}")))
        .collect::<Result<Vec<_>, _>>()?;
    let limit = limit.unwrap_or(100).clamp(1, MAX_LIMIT);
    let query_url = http_query_url(relay_url)?;

    let mut filter = serde_json::json!({
        "kinds": [9, 40002, 40003, 40008],
        "#h": [channel_id],
        "authors": author_pubkeys,
        "limit": limit,
    });
    if let Some(since) = since {
        filter["since"] = serde_json::json!(since);
    }
    let body =
        serde_json::to_vec(&[filter]).map_err(|error| format!("encode relay query: {error}"))?;
    let authorization = sign_nip98(device_keys, &query_url, &body)?;
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|error| format!("build relay client: {error}"))?
        .post(&query_url)
        .header("Authorization", authorization)
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|error| format!("connect to relay: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        let detail = response.text().await.unwrap_or_default();
        let safe_detail = if detail.contains("relay_membership_required") {
            "device authorization required"
        } else if status.as_u16() == 403 {
            "device is not authorized for this relay or channel"
        } else {
            "relay rejected the read-only query"
        };
        return Err(format!("{safe_detail} (HTTP {})", status.as_u16()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES)
    {
        return Err("relay response exceeds the 2 MiB safety limit".to_string());
    }
    let response_body = response
        .bytes()
        .await
        .map_err(|error| format!("read relay response: {error}"))?;
    if response_body.len() as u64 > MAX_RESPONSE_BYTES {
        return Err("relay response exceeds the 2 MiB safety limit".to_string());
    }
    let events = serde_json::from_slice::<Vec<Event>>(&response_body)
        .map_err(|error| format!("decode relay response: {error}"))?;

    Ok(RelayActivityPage {
        relay_url: relay_url.to_string(),
        channel_id: channel_id.to_string(),
        device_pubkey: device_keys.public_key().to_hex(),
        messages: validate_messages(events, channel_id, &authors)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{Keys, Timestamp};

    fn signed_message(author: &Keys, channel_id: &str, content: &str) -> Event {
        EventBuilder::new(Kind::Custom(9), content)
            .tags([Tag::parse(["h", channel_id]).expect("channel tag")])
            .custom_created_at(Timestamp::from(1_800_000_000))
            .sign_with_keys(author)
            .expect("signed message")
    }

    #[test]
    fn maps_signed_channel_messages() {
        let author = Keys::generate();
        let channel = "0b7c0958-3f7f-48c8-af3f-31e549b10e31";
        let event = signed_message(&author, channel, "Companion-only update");
        let messages = validate_messages(vec![event.clone()], channel, &[author.public_key()])
            .expect("valid message page");

        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].id, event.id.to_hex());
        assert_eq!(messages[0].content, "Companion-only update");
    }

    #[test]
    fn rejects_wrong_channel_or_author() {
        let author = Keys::generate();
        let other = Keys::generate();
        let channel = "0b7c0958-3f7f-48c8-af3f-31e549b10e31";
        let event = signed_message(&author, channel, "visible");

        assert!(validate_messages(
            vec![event.clone()],
            "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            &[author.public_key()]
        )
        .is_err());
        assert!(validate_messages(vec![event], channel, &[other.public_key()]).is_err());
    }

    #[test]
    fn converts_only_websocket_relay_urls() {
        assert_eq!(
            http_query_url("wss://buzz.nilor.cool/").expect("valid relay"),
            "https://buzz.nilor.cool/query"
        );
        assert!(http_query_url("https://buzz.nilor.cool").is_err());
        assert!(http_query_url("wss://user@buzz.nilor.cool").is_err());
        assert!(http_query_url("wss://buzz.nilor.cool?tenant=other").is_err());
    }
}
