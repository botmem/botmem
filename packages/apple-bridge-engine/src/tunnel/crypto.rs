//! Tunnel crypto — MUST match `packages/apple-bridge/src/crypto.ts` and the
//! server (`apple-tunnel.service.ts`) exactly. See PROTOCOL.md §4.
//!
//!   X25519 (raw 32-byte keys on the wire)
//!   → ECDH shared secret
//!   → HKDF-SHA256(salt="botmem-apple-tunnel-v1", info="aes-256-gcm-session-key", 32)
//!   → AES-256-GCM, frame = [IV(12)] [ciphertext] [tag(16)]
//!
//! NB: the Node side wraps/unwraps a 12-byte X25519 SPKI DER header around the
//! raw key purely because its KeyObject API needs DER. The ECDH itself operates
//! on the raw 32 bytes, which is exactly what we put on the wire — so here we
//! work with raw bytes directly and never touch the DER header.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use hkdf::Hkdf;
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};

use super::{HKDF_INFO, HKDF_SALT, IV_LEN, TAG_LEN};

/// An ephemeral X25519 keypair for one tunnel connection.
pub struct KeyPair {
    secret: StaticSecret,
    pub public_raw: [u8; 32],
}

impl KeyPair {
    /// Generate a fresh ephemeral keypair.
    pub fn generate() -> Result<Self, CryptoError> {
        let mut seed = [0u8; 32];
        getrandom::getrandom(&mut seed).map_err(|_| CryptoError::Rng)?;
        // StaticSecret applies X25519 clamping on construction.
        let secret = StaticSecret::from(seed);
        let public = PublicKey::from(&secret);
        Ok(Self { secret, public_raw: *public.as_bytes() })
    }

    /// Derive the AES-256 session key from the remote raw 32-byte public key.
    pub fn derive_session_key(&self, remote_public_raw: &[u8]) -> Result<[u8; 32], CryptoError> {
        if remote_public_raw.len() != 32 {
            return Err(CryptoError::BadPublicKey);
        }
        let mut pk = [0u8; 32];
        pk.copy_from_slice(remote_public_raw);
        let remote = PublicKey::from(pk);
        let shared = self.secret.diffie_hellman(&remote);

        let hk = Hkdf::<Sha256>::new(Some(HKDF_SALT), shared.as_bytes());
        let mut okm = [0u8; 32];
        hk.expand(HKDF_INFO, &mut okm).map_err(|_| CryptoError::Hkdf)?;
        Ok(okm)
    }
}

/// Encrypt plaintext with AES-256-GCM. Output: `[IV(12)] [ciphertext] [tag(16)]`.
pub fn encrypt(key: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let cipher = Aes256Gcm::new(key.into());
    let mut iv = [0u8; IV_LEN];
    getrandom::getrandom(&mut iv).map_err(|_| CryptoError::Rng)?;
    let nonce = Nonce::from_slice(&iv);
    // aes-gcm returns ciphertext with the 16-byte tag appended → matches the
    // [ct][tag] tail of the wire frame.
    let ct = cipher
        .encrypt(nonce, Payload { msg: plaintext, aad: &[] })
        .map_err(|_| CryptoError::Encrypt)?;
    let mut out = Vec::with_capacity(IV_LEN + ct.len());
    out.extend_from_slice(&iv);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Decrypt an `[IV(12)] [ciphertext] [tag(16)]` frame.
pub fn decrypt(key: &[u8; 32], frame: &[u8]) -> Result<Vec<u8>, CryptoError> {
    if frame.len() < IV_LEN + TAG_LEN {
        return Err(CryptoError::FrameTooShort);
    }
    let cipher = Aes256Gcm::new(key.into());
    let (iv, ct_and_tag) = frame.split_at(IV_LEN);
    let nonce = Nonce::from_slice(iv);
    cipher
        .decrypt(nonce, Payload { msg: ct_and_tag, aad: &[] })
        .map_err(|_| CryptoError::Decrypt)
}

#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
    #[error("rng failure")]
    Rng,
    #[error("remote public key must be 32 bytes")]
    BadPublicKey,
    #[error("hkdf expand failed")]
    Hkdf,
    #[error("aes-gcm encrypt failed")]
    Encrypt,
    #[error("aes-gcm decrypt/auth failed")]
    Decrypt,
    #[error("frame shorter than 28 bytes")]
    FrameTooShort,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ecdh_both_sides_agree() {
        let a = KeyPair::generate().unwrap();
        let b = KeyPair::generate().unwrap();
        let ka = a.derive_session_key(&b.public_raw).unwrap();
        let kb = b.derive_session_key(&a.public_raw).unwrap();
        assert_eq!(ka, kb, "both ends must derive the same session key");
    }

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let a = KeyPair::generate().unwrap();
        let b = KeyPair::generate().unwrap();
        let key = a.derive_session_key(&b.public_raw).unwrap();

        let msg = br#"{"jsonrpc":"2.0","id":1,"result":{"pong":true}}"#;
        let frame = encrypt(&key, msg).unwrap();
        // frame = IV(12) + ct + tag(16)
        assert!(frame.len() >= IV_LEN + TAG_LEN);
        assert_eq!(frame.len(), IV_LEN + msg.len() + TAG_LEN);

        let out = decrypt(&key, &frame).unwrap();
        assert_eq!(out, msg);
    }

    #[test]
    fn each_frame_has_unique_iv() {
        let a = KeyPair::generate().unwrap();
        let b = KeyPair::generate().unwrap();
        let key = a.derive_session_key(&b.public_raw).unwrap();
        let f1 = encrypt(&key, b"hello").unwrap();
        let f2 = encrypt(&key, b"hello").unwrap();
        assert_ne!(&f1[..IV_LEN], &f2[..IV_LEN], "IVs must be random per frame");
    }

    #[test]
    fn tampered_frame_fails_auth() {
        let a = KeyPair::generate().unwrap();
        let b = KeyPair::generate().unwrap();
        let key = a.derive_session_key(&b.public_raw).unwrap();
        let mut frame = encrypt(&key, b"secret").unwrap();
        let last = frame.len() - 1;
        frame[last] ^= 0xff; // flip a tag byte
        assert!(matches!(decrypt(&key, &frame), Err(CryptoError::Decrypt)));
    }

    #[test]
    fn short_frame_rejected() {
        let key = [0u8; 32];
        assert!(matches!(decrypt(&key, &[0u8; 10]), Err(CryptoError::FrameTooShort)));
    }

    #[test]
    fn rejects_wrong_length_public_key() {
        let a = KeyPair::generate().unwrap();
        assert!(matches!(a.derive_session_key(&[0u8; 16]), Err(CryptoError::BadPublicKey)));
    }
}
