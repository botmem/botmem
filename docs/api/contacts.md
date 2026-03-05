# Contacts API

## List Contacts

```
GET /api/contacts
```

### Query Parameters

| Parameter | Type | Default | Description |
|---|---|---|---|
| `limit` | number | 50 | Page size |
| `offset` | number | 0 | Pagination offset |

### Response

Returns a list of contact objects with their identifiers.

---

## Get Contact

```
GET /api/contacts/:id
```

### Response

```json
{
  "id": "contact-uuid",
  "displayName": "John Smith",
  "avatars": "[{\"url\":\"data:image/jpeg;base64,...\",\"source\":\"google\"}]",
  "metadata": "{\"organizations\":[{\"name\":\"Acme Corp\",\"title\":\"VP Engineering\"}],\"birthday\":\"1985-03-15\"}",
  "createdAt": "2026-01-10T00:00:00Z",
  "updatedAt": "2026-02-15T00:00:00Z"
}
```

---

## Get Contact Memories

Returns all memories associated with a contact.

```
GET /api/contacts/:id/memories
```

### Response

Returns a list of memory objects linked to this contact, including the role (sender, recipient, participant, mentioned).

---

## Search Contacts

Search contacts by name, email, phone, or any identifier value.

```
POST /api/contacts/search
```

### Request Body

```json
{
  "query": "John"
}
```

### Response

Returns a list of matching contacts with their identifiers.

---

## Update Contact

Update a contact's display name, avatars, or metadata.

```
PATCH /api/contacts/:id
```

### Request Body

```json
{
  "displayName": "John A. Smith",
  "avatars": [
    { "url": "data:image/jpeg;base64,...", "source": "google" }
  ],
  "metadata": {
    "organizations": [{ "name": "Acme Corp", "title": "VP Engineering" }],
    "birthday": "1985-03-15"
  }
}
```

All fields are optional.

### Response

Returns the updated contact object.

---

## Delete Contact

Removes a contact and all its identifier records.

```
DELETE /api/contacts/:id
```

### Response

```json
{
  "deleted": true
}
```

---

## Merge Contacts

Merge a source contact into a target contact. All identifiers and memory links from the source are transferred to the target, and the source is deleted.

```
POST /api/contacts/:id/merge
```

### Request Body

```json
{
  "sourceId": "contact-to-merge-uuid"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `sourceId` | string | Yes | UUID of the contact to merge into the target |

### Response

Returns the merged contact object.

---

## Get Merge Suggestions

Returns pairs of contacts that may be duplicates.

```
GET /api/contacts/suggestions
```

### Response

Returns a list of suggested merge pairs with a reason for the suggestion.

---

## Dismiss Merge Suggestion

Mark two contacts as intentionally separate (not duplicates).

```
POST /api/contacts/suggestions/dismiss
```

### Request Body

```json
{
  "contactId1": "contact-uuid-1",
  "contactId2": "contact-uuid-2"
}
```

### Response

```json
{
  "dismissed": true
}
```

Dismissed pairs will not appear in future merge suggestions.

---

## Normalize Contacts

Runs normalization across all contacts (e.g., email lowercasing, phone formatting).

```
POST /api/contacts/normalize
```

### Response

Returns a summary of the normalization results.
