//! User presence over the relay's signed read-only query surface.
//!
//! Presence *writes* are ephemeral kind:20001 events, but the relay keeps the
//! latest status per pubkey in Redis and synthesizes relay-signed presence
//! events on demand when every filter in a query targets kind 20001 or 40902
//! with an `authors` list. The synthesized event is authored by the *relay*
//! keypair — the subject rides in the `p` tag — with the bare status string
//! ("online" / "away" / "offline") as content and `created_at` stamped at
//! query time (so it says nothing about how long the subject has been in that
//! state). Verified live against buzz.nilor.cool 2026-09-01.

use nostr::Event;
use serde::Serialize;

use crate::channel_directory::tag_value;
use crate::relay_activity::post_signed_query;

const PRESENCE_SNAPSHOT_KIND: u16 = 40_902;
const PRESENCE_UPDATE_KIND: u16 = 20_001;
const MAX_PUBKEYS: usize = 50;
const MAX_STATUS_CHARS: usize = 32;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PresenceEntry {
    pub pubkey: String,
    pub status: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresencePage {
    pub statuses: Vec<PresenceEntry>,
}

fn is_hex64(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|char| char.is_ascii_hexdigit())
}

/// Reduce a page of relay events to at most one presence entry per requested
/// pubkey. Non-presence kinds, invalid signatures, subjects outside the
/// requested set, and unbounded status strings are skipped silently; a
/// duplicate subject resolves to the newest `created_at`.
pub(crate) fn collect_presence(events: &[Event], requested: &[String]) -> Vec<PresenceEntry> {
    let mut newest: Vec<(u64, PresenceEntry)> = Vec::new();
    for event in events {
        let kind = event.kind.as_u16();
        if kind != PRESENCE_UPDATE_KIND && kind != PRESENCE_SNAPSHOT_KIND {
            continue;
        }
        if !event.verify_id() || !event.verify_signature() {
            continue;
        }
        // The subject is the p tag on synthesized events; a raw kind-20001
        // update (self-authored) carries no p tag, so fall back to the author.
        let subject = tag_value(event, "p")
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| event.pubkey.to_hex());
        if !requested
            .iter()
            .any(|pubkey| pubkey.eq_ignore_ascii_case(&subject))
        {
            continue;
        }
        let status = event.content.trim();
        if status.is_empty()
            || status.chars().count() > MAX_STATUS_CHARS
            || !status
                .chars()
                .all(|char| char.is_ascii_alphanumeric() || char == '-' || char == '_')
        {
            continue;
        }
        let created_at = event.created_at.as_secs();
        let entry = PresenceEntry {
            pubkey: subject.to_ascii_lowercase(),
            status: status.to_ascii_lowercase(),
        };
        match newest.iter_mut().find(|(_, existing)| existing.pubkey == entry.pubkey) {
            Some((existing_at, existing)) => {
                if created_at > *existing_at {
                    *existing_at = created_at;
                    *existing = entry;
                }
            }
            None => newest.push((created_at, entry)),
        }
    }
    newest.into_iter().map(|(_, entry)| entry).collect()
}

/// Load the relay's current presence snapshot for a set of pubkeys. Hard
/// errors only on transport failures or invalid input; a pubkey with no
/// presence entry in Redis is simply absent from the result.
pub async fn load_presence(
    device_keys: &nostr::Keys,
    relay_url: &str,
    pubkeys: &[String],
) -> Result<PresencePage, String> {
    if pubkeys.is_empty() {
        return Ok(PresencePage { statuses: Vec::new() });
    }
    if pubkeys.len() > MAX_PUBKEYS {
        return Err(format!("presence query is capped at {MAX_PUBKEYS} pubkeys"));
    }
    for pubkey in pubkeys {
        if !is_hex64(pubkey) {
            return Err(format!("invalid presence pubkey: {pubkey}"));
        }
    }
    // The relay only takes the presence fast path when every filter is a
    // single presence kind with authors — keep this query presence-only.
    let filters = serde_json::json!([
        { "kinds": [PRESENCE_SNAPSHOT_KIND], "authors": pubkeys, "limit": pubkeys.len() },
    ]);
    let events = post_signed_query(device_keys, relay_url, &filters).await?;
    Ok(PresencePage {
        statuses: collect_presence(&events, pubkeys),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};

    fn synthesized(relay: &Keys, subject: &str, status: &str, at: u64) -> Event {
        EventBuilder::new(Kind::Custom(PRESENCE_UPDATE_KIND), status)
            .tags([Tag::parse(["p", subject]).expect("p tag")])
            .custom_created_at(Timestamp::from(at))
            .sign_with_keys(relay)
            .expect("signed presence event")
    }

    #[test]
    fn maps_relay_synthesized_presence_to_the_p_tag_subject() {
        let relay = Keys::generate();
        let subject = "ab".repeat(32);
        let entries = collect_presence(
            &[synthesized(&relay, &subject, "online", 1_800_000_000)],
            &[subject.clone()],
        );
        assert_eq!(
            entries,
            vec![PresenceEntry {
                pubkey: subject,
                status: "online".into(),
            }]
        );
    }

    #[test]
    fn skips_subjects_outside_the_requested_set_and_bad_status() {
        let relay = Keys::generate();
        let requested = vec!["ab".repeat(32)];
        let stranger = synthesized(&relay, &"cd".repeat(32), "online", 1);
        assert!(collect_presence(&[stranger], &requested).is_empty());

        let oversized = synthesized(&relay, &requested[0], &"x".repeat(64), 1);
        assert!(collect_presence(&[oversized], &requested).is_empty());

        let markup = synthesized(&relay, &requested[0], "on line!", 1);
        assert!(collect_presence(&[markup], &requested).is_empty());

        let wrong_kind = EventBuilder::new(Kind::Custom(9), "online")
            .tags([Tag::parse(["p", requested[0].as_str()]).expect("p tag")])
            .sign_with_keys(&relay)
            .expect("signed event");
        assert!(collect_presence(&[wrong_kind], &requested).is_empty());
    }

    #[test]
    fn duplicate_subjects_resolve_to_the_newest_event() {
        let relay = Keys::generate();
        let subject = "ab".repeat(32);
        let older = synthesized(&relay, &subject, "away", 1_800_000_000);
        let newer = synthesized(&relay, &subject, "online", 1_800_000_100);
        let entries = collect_presence(&[older.clone(), newer.clone()], &[subject.clone()]);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].status, "online");
        let entries = collect_presence(&[newer, older], &[subject]);
        assert_eq!(entries[0].status, "online");
    }

    #[test]
    fn self_authored_updates_without_p_tag_fall_back_to_the_author() {
        let author = Keys::generate();
        let event = EventBuilder::new(Kind::Custom(PRESENCE_UPDATE_KIND), "online")
            .sign_with_keys(&author)
            .expect("signed event");
        let entries = collect_presence(&[event], &[author.public_key().to_hex()]);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].pubkey, author.public_key().to_hex());
    }
}
