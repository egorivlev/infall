//! Encryption at rest for Members' OpenRouter keys (contract §14): XChaCha20-Poly1305 under
//! the server's `INFALL_SECRET_KEY`, a fresh random nonce per value, and the Member's id as
//! associated data so a sealed value cannot be moved to another account.
//!
//! Nothing here ever formats a key: `SecretKey` and `Opened` print as `[redacted]`.

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use infall_core::MemberId;
use rand::TryRng;
use rand::rngs::SysRng;

/// Bytes of key material.
pub const KEY_BYTES: usize = 32;
/// Bytes of nonce stored next to each sealed value.
pub const NONCE_BYTES: usize = 24;

/// The server's secret: 32 bytes. Never printed.
#[derive(Clone)]
pub struct SecretKey([u8; KEY_BYTES]);

impl std::fmt::Debug for SecretKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SecretKey([redacted])")
    }
}

/// A value read back from its sealed form. Never printed.
pub struct Opened(String);

impl Opened {
    /// The value in the clear; keep it only as long as the request that needs it.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Opened {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Opened([redacted])")
    }
}

/// A sealed value: what is stored.
pub struct Sealed {
    pub ciphertext: Vec<u8>,
    pub nonce: Vec<u8>,
}

fn random<const N: usize>() -> Result<[u8; N], String> {
    let mut bytes = [0u8; N];
    SysRng
        .try_fill_bytes(&mut bytes)
        .map_err(|e| format!("OS randomness unavailable: {e}"))?;
    Ok(bytes)
}

impl SecretKey {
    /// Reads `INFALL_SECRET_KEY`: 32 bytes as base64 (standard or URL-safe alphabet, padded
    /// or not). The error says what is wrong without repeating the value.
    pub fn from_base64(raw: &str) -> Result<SecretKey, String> {
        let raw = raw.trim();
        let bytes = [&STANDARD, &STANDARD_NO_PAD, &URL_SAFE, &URL_SAFE_NO_PAD]
            .iter()
            .find_map(|engine| engine.decode(raw).ok())
            .ok_or("is not valid base64")?;
        let bytes: [u8; KEY_BYTES] = bytes.try_into().map_err(|b: Vec<u8>| {
            format!(
                "must be {KEY_BYTES} bytes of base64, but decodes to {}",
                b.len()
            )
        })?;
        Ok(SecretKey(bytes))
    }

    /// A fresh key from the OS RNG.
    pub fn generate() -> Result<SecretKey, String> {
        Ok(SecretKey(random()?))
    }

    /// The key as `INFALL_SECRET_KEY` takes it. Only `gen-secret-key` and the secret key file
    /// of a Local Workspace call this.
    pub fn to_base64(&self) -> String {
        STANDARD.encode(self.0)
    }

    fn cipher(&self) -> XChaCha20Poly1305 {
        XChaCha20Poly1305::new(&Key::from(self.0))
    }

    /// Seals `value` for `owner` under a fresh random nonce.
    pub fn seal(&self, owner: MemberId, value: &str) -> Result<Sealed, String> {
        let nonce: [u8; NONCE_BYTES] = random()?;
        let ciphertext = self
            .cipher()
            .encrypt(
                &XNonce::from(nonce),
                Payload {
                    msg: value.as_bytes(),
                    aad: owner.0.as_bytes(),
                },
            )
            .map_err(|_| "sealing failed".to_string())?;
        Ok(Sealed {
            ciphertext,
            nonce: nonce.to_vec(),
        })
    }

    /// The value sealed for `owner`; `None` if it was sealed under another key or for
    /// another Member, or was changed in any way since.
    pub fn open(&self, owner: MemberId, ciphertext: &[u8], nonce: &[u8]) -> Option<Opened> {
        let nonce: [u8; NONCE_BYTES] = nonce.try_into().ok()?;
        let clear = self
            .cipher()
            .decrypt(
                &XNonce::from(nonce),
                Payload {
                    msg: ciphertext,
                    aad: owner.0.as_bytes(),
                },
            )
            .ok()?;
        String::from_utf8(clear).ok().map(Opened)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn member() -> MemberId {
        MemberId(Uuid::new_v4())
    }

    #[test]
    fn a_sealed_value_opens_only_under_its_key_for_its_owner_and_untouched() {
        let (key, other) = (
            SecretKey::generate().unwrap(),
            SecretKey::generate().unwrap(),
        );
        let (ada, bea) = (member(), member());
        let sealed = key.seal(ada, "sk-or-v1-something-secret").unwrap();
        assert_eq!(sealed.nonce.len(), NONCE_BYTES);
        assert!(
            !sealed
                .ciphertext
                .windows(6)
                .any(|w| w == b"secret" || w == b"sk-or-")
        );
        let opened = key.open(ada, &sealed.ciphertext, &sealed.nonce).unwrap();
        assert_eq!(opened.expose(), "sk-or-v1-something-secret");

        assert!(other.open(ada, &sealed.ciphertext, &sealed.nonce).is_none());
        assert!(key.open(bea, &sealed.ciphertext, &sealed.nonce).is_none());
        for i in 0..sealed.ciphertext.len() {
            let mut bent = sealed.ciphertext.clone();
            bent[i] ^= 1;
            assert!(key.open(ada, &bent, &sealed.nonce).is_none(), "byte {i}");
        }
        let mut nonce = sealed.nonce.clone();
        nonce[0] ^= 1;
        assert!(key.open(ada, &sealed.ciphertext, &nonce).is_none());
        // Malformed stored values are refused, not a panic.
        assert!(key.open(ada, &sealed.ciphertext, &nonce[..5]).is_none());
        assert!(key.open(ada, &[], &sealed.nonce).is_none());
        assert!(key.open(ada, &sealed.ciphertext[..3], &[]).is_none());
    }

    #[test]
    fn every_value_gets_its_own_nonce() {
        let key = SecretKey::generate().unwrap();
        let ada = member();
        let (a, b) = (
            key.seal(ada, "same").unwrap(),
            key.seal(ada, "same").unwrap(),
        );
        assert_ne!(a.nonce, b.nonce);
        assert_ne!(a.ciphertext, b.ciphertext);
    }

    #[test]
    fn the_secret_key_is_exactly_32_bytes_of_base64_and_never_printed() {
        let key = SecretKey::generate().unwrap();
        let text = key.to_base64();
        assert_eq!(SecretKey::from_base64(&text).unwrap().0, key.0);
        assert_eq!(
            SecretKey::from_base64(&format!("  {}\n", text.trim_end_matches('=')))
                .unwrap()
                .0,
            key.0
        );
        let url_safe = URL_SAFE_NO_PAD.encode(key.0);
        assert_eq!(SecretKey::from_base64(&url_safe).unwrap().0, key.0);

        let short = STANDARD.encode([7u8; 16]);
        let why = SecretKey::from_base64(&short).unwrap_err();
        assert!(why.contains("32 bytes") && why.contains("16"), "{why}");
        assert!(!why.contains(&short));
        let long = STANDARD.encode([7u8; 33]);
        assert!(SecretKey::from_base64(&long).is_err());
        let why = SecretKey::from_base64("not base64 at all!").unwrap_err();
        assert!(why.contains("base64") && !why.contains("at all"), "{why}");
        assert!(SecretKey::from_base64("").is_err());

        assert_eq!(format!("{key:?}"), "SecretKey([redacted])");
        let opened = Opened("sk-or-v1-abc".to_string());
        assert_eq!(format!("{opened:?}"), "Opened([redacted])");
    }
}
