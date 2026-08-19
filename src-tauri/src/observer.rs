use nostr::{nips::nip44, Event, PublicKey};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use zeroize::Zeroize;

pub const KIND_AGENT_OBSERVER_FRAME: u16 = 24_200;
const NIP44_MIN_CONTENT_LEN: usize = 132;
const NIP44_MAX_CONTENT_LEN: usize = 87_472;
const OBSERVER_MAX_PLAINTEXT_LEN: usize = 65_535;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ObserverEvent {
    pub seq: u64,
    pub timestamp: String,
    pub kind: String,
    pub agent_index: Option<usize>,
    pub channel_id: Option<String>,
    pub session_id: Option<String>,
    pub turn_id: Option<String>,
    pub started_at: Option<String>,
    pub payload: serde_json::Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidatedObserverFrame {
    pub event_id: String,
    pub agent_pubkey: String,
    pub recipient_pubkey: String,
    pub event: ObserverEvent,
}

#[derive(Debug, Error)]
pub enum ObserverFrameError {
    #[error("invalid relay event JSON: {0}")]
    InvalidEventJson(serde_json::Error),
    #[error("invalid decrypted observer payload JSON: {0}")]
    InvalidPayloadJson(serde_json::Error),
    #[error("observer event signature or id is invalid")]
    InvalidSignature,
    #[error("expected kind {KIND_AGENT_OBSERVER_FRAME}, got {0}")]
    WrongKind(u16),
    #[error("observer frame is missing exactly one {0:?} tag")]
    InvalidTag(&'static str),
    #[error("observer frame must have frame=telemetry")]
    WrongDirection,
    #[error("observer frame author does not match its agent tag")]
    AuthorAgentMismatch,
    #[error("observer frame recipient does not match this device")]
    WrongRecipient,
    #[error("observer frame agent does not match the selected agent")]
    WrongAgent,
    #[error("observer ciphertext length is outside the NIP-44 v2 envelope")]
    InvalidCiphertextLength,
    #[error("NIP-44 decryption failed: {0}")]
    Decryption(#[from] nip44::Error),
    #[error("observer plaintext exceeds {OBSERVER_MAX_PLAINTEXT_LEN} bytes")]
    PlaintextTooLarge,
    #[error("observer frame channel does not match the active channel")]
    WrongChannel,
}

fn single_tag<'a>(event: &'a Event, name: &'static str) -> Result<&'a str, ObserverFrameError> {
    let mut tags = event
        .tags
        .iter()
        .filter(|tag| tag.as_slice().first().is_some_and(|value| value == name));
    let fields = tags
        .next()
        .ok_or(ObserverFrameError::InvalidTag(name))?
        .as_slice();
    if fields.len() != 2 || tags.next().is_some() {
        return Err(ObserverFrameError::InvalidTag(name));
    }
    Ok(fields[1].as_str())
}

pub fn validate_and_decrypt(
    device_keys: &nostr::Keys,
    event_json: &str,
    expected_agent: Option<&str>,
    expected_channel: Option<&str>,
) -> Result<ValidatedObserverFrame, ObserverFrameError> {
    let event: Event =
        serde_json::from_str(event_json).map_err(ObserverFrameError::InvalidEventJson)?;
    if !event.verify_id() || !event.verify_signature() {
        return Err(ObserverFrameError::InvalidSignature);
    }
    if event.kind.as_u16() != KIND_AGENT_OBSERVER_FRAME {
        return Err(ObserverFrameError::WrongKind(event.kind.as_u16()));
    }

    let recipient = single_tag(&event, "p")?;
    let agent = single_tag(&event, "agent")?;
    let frame = single_tag(&event, "frame")?;
    if frame != "telemetry" {
        return Err(ObserverFrameError::WrongDirection);
    }
    if event.pubkey.to_hex() != agent {
        return Err(ObserverFrameError::AuthorAgentMismatch);
    }

    let recipient_pubkey =
        PublicKey::parse(recipient).map_err(|_| ObserverFrameError::InvalidTag("p"))?;
    if recipient_pubkey != device_keys.public_key() {
        return Err(ObserverFrameError::WrongRecipient);
    }
    if expected_agent.is_some_and(|expected| expected != agent) {
        return Err(ObserverFrameError::WrongAgent);
    }
    if !(NIP44_MIN_CONTENT_LEN..=NIP44_MAX_CONTENT_LEN).contains(&event.content.len()) {
        return Err(ObserverFrameError::InvalidCiphertextLength);
    }

    let mut plaintext = nip44::decrypt(
        device_keys.secret_key(),
        &event.pubkey,
        event.content.as_str(),
    )?;
    if plaintext.len() > OBSERVER_MAX_PLAINTEXT_LEN {
        plaintext.zeroize();
        return Err(ObserverFrameError::PlaintextTooLarge);
    }
    let parsed = serde_json::from_str::<ObserverEvent>(&plaintext)
        .map_err(ObserverFrameError::InvalidPayloadJson);
    plaintext.zeroize();
    let parsed = parsed?;

    if expected_channel.is_some_and(|expected| parsed.channel_id.as_deref() != Some(expected)) {
        return Err(ObserverFrameError::WrongChannel);
    }

    Ok(ValidatedObserverFrame {
        event_id: event.id.to_hex(),
        agent_pubkey: agent.to_string(),
        recipient_pubkey: recipient.to_string(),
        event: parsed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag};

    fn payload() -> ObserverEvent {
        ObserverEvent {
            seq: 7,
            timestamp: "2026-08-19T04:07:00Z".into(),
            kind: "turn_started".into(),
            agent_index: Some(0),
            channel_id: Some("channel-1".into()),
            session_id: Some("session-1".into()),
            turn_id: Some("turn-1".into()),
            started_at: Some("2026-08-19T04:07:00Z".into()),
            payload: serde_json::json!({"safeOperation": "Inspecting repository"}),
        }
    }

    fn frame(agent: &Keys, recipient: &Keys, payload: &ObserverEvent) -> Event {
        let plaintext = serde_json::to_string(payload).expect("serialize payload");
        let encrypted = nip44::encrypt(
            agent.secret_key(),
            &recipient.public_key(),
            plaintext,
            nip44::Version::V2,
        )
        .expect("encrypt payload");
        EventBuilder::new(Kind::Custom(KIND_AGENT_OBSERVER_FRAME), encrypted)
            .tags([
                Tag::parse(["p", &recipient.public_key().to_hex()]).expect("p tag"),
                Tag::parse(["agent", &agent.public_key().to_hex()]).expect("agent tag"),
                Tag::parse(["frame", "telemetry"]).expect("frame tag"),
            ])
            .sign_with_keys(agent)
            .expect("sign frame")
    }

    #[test]
    fn accepts_signed_device_encrypted_frame() {
        let agent = Keys::generate();
        let device = Keys::generate();
        let event = frame(&agent, &device, &payload());
        let decoded = validate_and_decrypt(
            &device,
            &serde_json::to_string(&event).expect("event JSON"),
            Some(&agent.public_key().to_hex()),
            Some("channel-1"),
        )
        .expect("valid observer frame");

        assert_eq!(decoded.agent_pubkey, agent.public_key().to_hex());
        assert_eq!(decoded.recipient_pubkey, device.public_key().to_hex());
        assert_eq!(decoded.event, payload());
    }

    #[test]
    fn rejects_frame_for_another_device_before_decrypting() {
        let agent = Keys::generate();
        let device = Keys::generate();
        let other = Keys::generate();
        let event = frame(&agent, &other, &payload());

        let result = validate_and_decrypt(
            &device,
            &serde_json::to_string(&event).expect("event JSON"),
            None,
            None,
        );
        assert!(matches!(result, Err(ObserverFrameError::WrongRecipient)));
    }

    #[test]
    fn rejects_selected_agent_or_channel_mismatch() {
        let agent = Keys::generate();
        let device = Keys::generate();
        let event = frame(&agent, &device, &payload());
        let json = serde_json::to_string(&event).expect("event JSON");

        assert!(matches!(
            validate_and_decrypt(
                &device,
                &json,
                Some(&Keys::generate().public_key().to_hex()),
                None
            ),
            Err(ObserverFrameError::WrongAgent)
        ));
        assert!(matches!(
            validate_and_decrypt(&device, &json, None, Some("channel-2")),
            Err(ObserverFrameError::WrongChannel)
        ));
    }

    #[test]
    fn rejects_validly_signed_author_agent_mismatch() {
        let author = Keys::generate();
        let claimed_agent = Keys::generate();
        let device = Keys::generate();
        let plaintext = serde_json::to_string(&payload()).expect("serialize payload");
        let encrypted = nip44::encrypt(
            author.secret_key(),
            &device.public_key(),
            plaintext,
            nip44::Version::V2,
        )
        .expect("encrypt payload");
        let event = EventBuilder::new(Kind::Custom(KIND_AGENT_OBSERVER_FRAME), encrypted)
            .tags([
                Tag::parse(["p", &device.public_key().to_hex()]).expect("p tag"),
                Tag::parse(["agent", &claimed_agent.public_key().to_hex()]).expect("agent tag"),
                Tag::parse(["frame", "telemetry"]).expect("frame tag"),
            ])
            .sign_with_keys(&author)
            .expect("sign frame");

        let result = validate_and_decrypt(
            &device,
            &serde_json::to_string(&event).expect("event JSON"),
            None,
            None,
        );
        assert!(matches!(
            result,
            Err(ObserverFrameError::AuthorAgentMismatch)
        ));
    }

    #[test]
    fn rejects_wrong_direction_and_duplicate_recipient_tags() {
        let agent = Keys::generate();
        let device = Keys::generate();
        let plaintext = serde_json::to_string(&payload()).expect("serialize payload");
        let encrypted = nip44::encrypt(
            agent.secret_key(),
            &device.public_key(),
            plaintext,
            nip44::Version::V2,
        )
        .expect("encrypt payload");
        let wrong_direction =
            EventBuilder::new(Kind::Custom(KIND_AGENT_OBSERVER_FRAME), encrypted.clone())
                .tags([
                    Tag::parse(["p", &device.public_key().to_hex()]).expect("p tag"),
                    Tag::parse(["agent", &agent.public_key().to_hex()]).expect("agent tag"),
                    Tag::parse(["frame", "receipt"]).expect("frame tag"),
                ])
                .sign_with_keys(&agent)
                .expect("sign frame");
        let duplicate_recipient =
            EventBuilder::new(Kind::Custom(KIND_AGENT_OBSERVER_FRAME), encrypted)
                .tags([
                    Tag::parse(["p", &device.public_key().to_hex()]).expect("p tag"),
                    Tag::parse(["p", &device.public_key().to_hex()]).expect("second p tag"),
                    Tag::parse(["agent", &agent.public_key().to_hex()]).expect("agent tag"),
                    Tag::parse(["frame", "telemetry"]).expect("frame tag"),
                ])
                .sign_with_keys(&agent)
                .expect("sign frame");

        assert!(matches!(
            validate_and_decrypt(
                &device,
                &serde_json::to_string(&wrong_direction).expect("event JSON"),
                None,
                None,
            ),
            Err(ObserverFrameError::WrongDirection)
        ));
        assert!(matches!(
            validate_and_decrypt(
                &device,
                &serde_json::to_string(&duplicate_recipient).expect("event JSON"),
                None,
                None,
            ),
            Err(ObserverFrameError::InvalidTag("p"))
        ));
    }

    #[test]
    fn rejects_tampered_signed_envelope() {
        let agent = Keys::generate();
        let device = Keys::generate();
        let event = frame(&agent, &device, &payload());
        let mut value = serde_json::to_value(event).expect("event value");
        value["created_at"] = serde_json::json!(1);

        let result = validate_and_decrypt(&device, &value.to_string(), None, None);
        assert!(matches!(result, Err(ObserverFrameError::InvalidSignature)));
    }
}
