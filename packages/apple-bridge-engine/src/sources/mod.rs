//! Read-only source readers over local Apple/WhatsApp databases.
//!
//! Phase 4 lands here, in order (Contacts first — it feeds name resolution):
//!   - `contacts`  — AddressBook `*/AddressBook-v22.abcddb` (multiple sources)
//!   - `whatsapp`  — `ChatStorage.sqlite` + `ContactsV2.sqlite` (LID→name)
//!   - `imessage`  — `chat.db`, incl. `attributedBody` typedstream decode
//!   - attachment text extraction (PDF/DOCX)
//!
//! All reads happen IN THIS PROCESS (the FDA-granted one), read-only, with
//! realpath-confined attachment access. Intentionally empty in Phase 1.
