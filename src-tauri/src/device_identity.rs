use nostr::Keys;
use serde::Serialize;
#[cfg(feature = "system-keyring")]
use zeroize::Zeroizing;

#[cfg(feature = "system-keyring")]
const KEYRING_SERVICE: &str = "cool.nilor.buzz-control-tower";
#[cfg(feature = "system-keyring")]
const KEYRING_ACCOUNT: &str = "observer-device-v1";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceIdentity {
    pub pubkey: String,
    pub fingerprint: String,
    pub storage: &'static str,
    pub created: bool,
}

pub fn public_identity(keys: &Keys, created: bool) -> DeviceIdentity {
    let pubkey = keys.public_key().to_hex();
    DeviceIdentity {
        fingerprint: pubkey.chars().take(12).collect(),
        pubkey,
        storage: "system-keyring",
        created,
    }
}

#[cfg(feature = "system-keyring")]
pub fn load_or_create_device_keys() -> Result<(Keys, bool), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|error| format!("open device keyring entry: {error}"))?;

    match entry.get_password() {
        Ok(secret) => {
            let secret = Zeroizing::new(secret);
            let keys = Keys::parse(secret.as_str())
                .map_err(|error| format!("parse stored device identity: {error}"))?;
            Ok((keys, false))
        }
        Err(keyring::Error::NoEntry) => {
            let keys = Keys::generate();
            let secret = Zeroizing::new(keys.secret_key().to_secret_hex());
            entry
                .set_password(secret.as_str())
                .map_err(|error| format!("store device identity in system keyring: {error}"))?;
            Ok((keys, true))
        }
        Err(error) => Err(format!("read device identity from system keyring: {error}")),
    }
}

#[cfg(not(feature = "system-keyring"))]
pub fn load_or_create_device_keys() -> Result<(Keys, bool), String> {
    Err("this build does not include system-keyring support".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_identity_never_exposes_secret_material() {
        let keys = Keys::generate();
        let secret = keys.secret_key().to_secret_hex();
        let identity = public_identity(&keys, true);

        assert_eq!(identity.pubkey, keys.public_key().to_hex());
        assert_eq!(identity.fingerprint, identity.pubkey[..12]);
        assert!(!identity.pubkey.contains(&secret));
        assert_eq!(identity.storage, "system-keyring");
        assert!(identity.created);
    }
}
