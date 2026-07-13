//! Attachment text extraction (PDF / DOCX / TXT / CSV / MD).
//! Ported from the `extractDocText` path in `local-index/sources/whatsapp.ts`.
//! Returns "" on any failure — extraction is best-effort and never fatal, and
//! never logs file contents.

use std::io::Read;
use std::path::Path;

/// Cap extracted text per file so one document can't bloat the index.
const MAX_DOC_CHARS: usize = 50_000;
/// Skip parsing attachments larger than this (cost guard).
const MAX_DOC_BYTES: u64 = 25 * 1024 * 1024;
/// Cap the decompressed size of a single zip entry (e.g. `word/document.xml`)
/// so a highly compressible "zip bomb" attachment cannot inflate to multi-GB.
const MAX_ENTRY_BYTES: u64 = 32 * 1024 * 1024;

/// Extract plain text from a downloaded attachment. "" on any failure/unknown type.
pub fn extract_doc_text(abs: &Path) -> String {
    let meta = match std::fs::metadata(abs) {
        Ok(m) if m.is_file() => m,
        _ => return String::new(),
    };
    if meta.len() > MAX_DOC_BYTES {
        return String::new();
    }
    let ext = abs
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();

    let text = match ext.as_str() {
        "pdf" => pdf_extract::extract_text(abs).unwrap_or_default(),
        "docx" => extract_docx(abs).unwrap_or_default(),
        "txt" | "csv" | "md" => std::fs::read_to_string(abs).unwrap_or_default(),
        _ => String::new(),
    };
    cap_chars(&text, MAX_DOC_CHARS)
}

fn cap_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect()
    }
}

/// Extract text from a .docx by reading `word/document.xml` and collecting the
/// runs (`<w:t>`), with tabs/paragraph breaks. Returns None on any failure.
fn extract_docx(path: &Path) -> Option<String> {
    use quick_xml::events::Event;
    use quick_xml::reader::Reader;

    let file = std::fs::File::open(path).ok()?;
    let mut zip = zip::ZipArchive::new(file).ok()?;
    let mut xml = String::new();
    zip.by_name("word/document.xml")
        .ok()?
        .take(MAX_ENTRY_BYTES)
        .read_to_string(&mut xml)
        .ok()?;

    let mut reader = Reader::from_str(&xml);
    reader.config_mut().trim_text(false);
    let mut out = String::new();
    let mut in_text = false;

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) if local_name_is(e.name().as_ref(), b"t") => in_text = true,
            Ok(Event::End(e)) if local_name_is(e.name().as_ref(), b"t") => in_text = false,
            Ok(Event::Text(e)) if in_text => {
                if let Ok(t) = e.unescape() {
                    out.push_str(&t);
                }
            }
            Ok(Event::Empty(e)) if local_name_is(e.name().as_ref(), b"tab") => out.push('\t'),
            // paragraph end → newline
            Ok(Event::End(e)) if local_name_is(e.name().as_ref(), b"p") => out.push('\n'),
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    Some(out)
}

/// True if `qname` (possibly `w:t`) has the given local name.
fn local_name_is(qname: &[u8], local: &[u8]) -> bool {
    match qname.iter().rposition(|&b| b == b':') {
        Some(i) => &qname[i + 1..] == local,
        None => qname == local,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn extracts_txt() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("note.txt");
        std::fs::write(&p, "the installment amount is 50,000").unwrap();
        assert_eq!(extract_doc_text(&p), "the installment amount is 50,000");
    }

    #[test]
    fn unknown_extension_yields_empty() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("photo.jpg");
        std::fs::write(&p, [0xff, 0xd8, 0xff]).unwrap();
        assert_eq!(extract_doc_text(&p), "");
    }

    #[test]
    fn missing_file_yields_empty() {
        assert_eq!(extract_doc_text(Path::new("/no/such/file.pdf")), "");
    }

    #[test]
    fn extracts_docx() {
        // Build a minimal .docx (zip with word/document.xml) in a temp file.
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("contract.docx");
        let f = std::fs::File::create(&p).unwrap();
        let mut zw = zip::ZipWriter::new(f);
        let opts: zip::write::FileOptions<'_, ()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zw.start_file("word/document.xml", opts).unwrap();
        zw.write_all(
            br#"<?xml version="1.0"?>
            <w:document xmlns:w="http://x">
              <w:body>
                <w:p><w:r><w:t>Parkwoods next installment</w:t></w:r></w:p>
                <w:p><w:r><w:t>due Friday</w:t></w:r></w:p>
              </w:body>
            </w:document>"#,
        )
        .unwrap();
        zw.finish().unwrap();

        let text = extract_doc_text(&p);
        assert!(text.contains("Parkwoods next installment"), "got: {text:?}");
        assert!(text.contains("due Friday"));
    }
}
