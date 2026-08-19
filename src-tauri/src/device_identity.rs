use nostr::Keys;
use serde::Serialize;
use std::sync::Mutex;
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

#[derive(Default)]
enum CachedDeviceKeys {
    #[default]
    Empty,
    Ready(Keys, bool),
    Failed(String),
}

#[derive(Default)]
pub struct DeviceIdentityStore {
    inner: Mutex<CachedDeviceKeys>,
}

impl DeviceIdentityStore {
    fn resolve_with(
        &self,
        loader: impl FnOnce() -> Result<(Keys, bool), String>,
    ) -> Result<(Keys, bool), String> {
        let mut cache = self
            .inner
            .lock()
            .map_err(|_| "device identity cache lock is poisoned".to_string())?;
        match &*cache {
            CachedDeviceKeys::Ready(keys, created) => return Ok((keys.clone(), *created)),
            CachedDeviceKeys::Failed(error) => return Err(error.clone()),
            CachedDeviceKeys::Empty => {}
        }

        match loader() {
            Ok((keys, created)) => {
                *cache = CachedDeviceKeys::Ready(keys.clone(), created);
                Ok((keys, created))
            }
            Err(error) => {
                *cache = CachedDeviceKeys::Failed(error.clone());
                Err(error)
            }
        }
    }

    pub fn keys(&self) -> Result<(Keys, bool), String> {
        self.resolve_with(load_or_create_device_keys)
    }
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
    use std::cell::Cell;

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

    #[test]
    fn device_store_loads_the_keyring_only_once() {
        let store = DeviceIdentityStore::default();
        let calls = Cell::new(0);
        let generated = Keys::generate();

        let first = store
            .resolve_with(|| {
                calls.set(calls.get() + 1);
                Ok((generated.clone(), true))
            })
            .expect("first load");
        let second = store
            .resolve_with(|| {
                calls.set(calls.get() + 1);
                Err("must not run".to_string())
            })
            .expect("cached load");

        assert_eq!(calls.get(), 1);
        assert_eq!(first.0.public_key(), second.0.public_key());
    }

    #[test]
    fn device_store_caches_a_denied_keyring_read() {
        let store = DeviceIdentityStore::default();
        let calls = Cell::new(0);

        for _ in 0..2 {
            let result = store.resolve_with(|| {
                calls.set(calls.get() + 1);
                Err("keyring access denied".to_string())
            });
            assert_eq!(result.unwrap_err(), "keyring access denied");
        }

        assert_eq!(calls.get(), 1);
    }
}
