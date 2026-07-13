//! Extract plain message text from an iMessage `attributedBody` blob.
//!
//! `attributedBody` is an NSAttributedString serialized as an NSKeyedArchiver
//! "typedstream". Rather than fully decode the typedstream, we port the proven
//! heuristic from `packages/apple-bridge/src/db.ts` (`extractAttributedBodyText`):
//! locate the `NSString` class name, then the archived-string marker, read the
//! archived length, and slice out the UTF-8 body — validating it looks like real
//! message text. This matches the node engine's output for result parity.
//!
//! (Codex flagged a full typedstream decoder as the #1 risk; the node heuristic
//! has been battle-tested on real chat.db data, so we port it verbatim and lean
//! on fixtures rather than reimplementing the format.)

const NS_STRING: &[u8] = b"NSString";
const MARKER: [u8; 4] = [0x95, 0x84, 0x01, 0x2b];

/// Decode the message text from an `attributedBody` blob, or "" if none found.
pub fn extract_attributed_body_text(body: &[u8]) -> String {
    if body.is_empty() {
        return String::new();
    }

    let mut search_from = 0usize;
    while search_from < body.len() {
        let string_class_at = match find_subslice(body, NS_STRING, search_from) {
            Some(i) => i,
            None => return String::new(),
        };
        let after_class = string_class_at + NS_STRING.len();

        let marker_at = match find_subslice(body, &MARKER, after_class) {
            Some(i) => i,
            None => return String::new(),
        };
        let length_at = marker_at + MARKER.len();

        match read_archived_string_length(body, length_at) {
            Some((length, off)) => {
                let start = length_at + off;
                let end = start.saturating_add(length);
                if length == 0 || end > body.len() {
                    search_from = after_class;
                    continue;
                }
                let text = String::from_utf8_lossy(&body[start..end])
                    .trim()
                    .to_string();
                if is_likely_message_text(&text) {
                    return text;
                }
                search_from = after_class;
            }
            None => {
                search_from = after_class;
            }
        }
    }
    String::new()
}

/// Read the archived string length at `offset`. Returns (length, bytes_consumed).
/// Short form: a single byte < 0x80 is the length. Long form: the low 7 bits of
/// the first byte give the byte-count (1..=4) of a big-endian length.
fn read_archived_string_length(body: &[u8], offset: usize) -> Option<(usize, usize)> {
    let first = *body.get(offset)?;
    if first < 0x80 {
        return Some((first as usize, 1));
    }
    let byte_count = (first & 0x7f) as usize;
    if byte_count == 0 || byte_count > 4 || offset + byte_count >= body.len() {
        return None;
    }
    let mut length: usize = 0;
    for i in 1..=byte_count {
        length = (length << 8) + body[offset + i] as usize;
    }
    Some((length, 1 + byte_count))
}

/// Heuristic: does this look like real message text rather than archiver noise?
fn is_likely_message_text(text: &str) -> bool {
    if text.is_empty() || text.contains('\u{0000}') {
        return false;
    }
    const BLOCKED: &[&str] = &[
        "NSString",
        "NSMutableString",
        "NSAttributedString",
        "NSMutableAttributedString",
        "NSObject",
        "NSDictionary",
        "NSNumber",
        "NSValue",
        "NSData",
        "NSMutableData",
        "NSKeyedArchiver",
    ];
    if BLOCKED.contains(&text) || text.starts_with("__kIM") {
        return false;
    }
    // Must contain at least one letter or number (\p{L} or \p{N}).
    text.chars().any(|c| c.is_alphanumeric())
}

/// First index of `needle` in `haystack` at or after `from`.
fn find_subslice(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || from > haystack.len() {
        return None;
    }
    haystack[from..]
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| p + from)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal attributedBody blob: …NSString <marker> <len><utf8>…
    fn blob_with(text: &str) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(b"\x04\x0bstreamtyped"); // typedstream preamble (ignored)
        v.extend_from_slice(b"NSString");
        v.extend_from_slice(b"\x01\x94\x84"); // filler between class and marker
        v.extend_from_slice(&MARKER);
        let bytes = text.as_bytes();
        if bytes.len() < 0x80 {
            v.push(bytes.len() as u8); // short length form
        } else {
            // long form: 0x81 + 2-byte big-endian
            v.push(0x82);
            v.push((bytes.len() >> 8) as u8);
            v.push((bytes.len() & 0xff) as u8);
        }
        v.extend_from_slice(bytes);
        v.extend_from_slice(b"\x86\x84"); // trailer
        v
    }

    #[test]
    fn extracts_short_string() {
        let b = blob_with("next installment is 50,000");
        assert_eq!(
            extract_attributed_body_text(&b),
            "next installment is 50,000"
        );
    }

    #[test]
    fn extracts_unicode_and_emoji() {
        let b = blob_with("مرحبا 👋 Parkwoods");
        assert_eq!(extract_attributed_body_text(&b), "مرحبا 👋 Parkwoods");
    }

    #[test]
    fn extracts_long_string() {
        let long = "x ".repeat(100); // 200 bytes → long-form length
        let b = blob_with(long.trim());
        assert_eq!(extract_attributed_body_text(&b), long.trim());
    }

    #[test]
    fn empty_blob_yields_empty() {
        assert_eq!(extract_attributed_body_text(&[]), "");
    }

    #[test]
    fn no_nsstring_yields_empty() {
        assert_eq!(
            extract_attributed_body_text(b"random bytes with no marker"),
            ""
        );
    }

    #[test]
    fn rejects_pure_class_noise() {
        // NSString + marker + "NSDictionary" (a blocked token) → skip, then nothing.
        let mut v = Vec::new();
        v.extend_from_slice(b"NSString");
        v.extend_from_slice(&MARKER);
        v.push(12);
        v.extend_from_slice(b"NSDictionary");
        assert_eq!(extract_attributed_body_text(&v), "");
    }
}
