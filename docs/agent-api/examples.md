# Agent Workflow Examples

These examples show how an AI agent can use Botmem's MCP tools to answer real questions by combining multiple tool calls.

## "What did John say about the project deadline?"

The agent needs to find a person and then search for relevant memories.

**Step 1: Find the contact**
```
Tool: search_contacts
Input: { "query": "John" }
```

Returns John Smith with contact ID `contact-uuid-1`.

**Step 2: Search memories involving John about deadlines**
```
Tool: search_memories
Input: {
  "query": "project deadline",
  "contactId": "contact-uuid-1",
  "limit": 10
}
```

Returns ranked memories from email, Slack, and WhatsApp where John discussed deadlines. The agent can synthesize a response:

> "Based on your memory, John mentioned the project deadline in three places:
> 1. In a Gmail email on Jan 15, he said the deadline is March 1st (FACT, confidence 0.9)
> 2. In Slack on Jan 20, he mentioned pushing it to March 15th (UNVERIFIED, confidence 0.6)
> 3. In WhatsApp on Jan 22, he confirmed March 15th with the team (FACT, confidence 0.85)"

## "Remember that the meeting was rescheduled to Friday"

The agent stores a new fact in memory.

```
Tool: store_memory
Input: {
  "text": "The team meeting originally scheduled for Wednesday has been rescheduled to Friday this week."
}
```

This creates a manual memory that will be embedded and enriched automatically. Future searches for "meeting schedule" or "Friday meeting" will surface this memory.

## "Give me a timeline of the product launch"

The agent builds a timeline by searching and sorting.

**Step 1: Broad search**
```
Tool: search_memories
Input: {
  "query": "product launch",
  "limit": 20
}
```

**Step 2: For each result, check the event time and source**

The agent receives memories from multiple sources and can construct a timeline:

> **Product Launch Timeline:**
>
> - **Jan 5** (Email, gmail) -- Initial launch date discussion: "targeting March 1st"
> - **Jan 12** (Message, slack) -- Design review: "mockups approved, dev starting next week"
> - **Jan 20** (Email, gmail) -- Delay notification: "moving to March 15th due to API changes"
> - **Feb 1** (Message, whatsapp) -- Team sync: "beta testing starts Feb 10"
> - **Feb 10** (Photo, photos) -- Screenshot of beta dashboard tagged with launch project

## "Who have I been talking to most about the budget?"

The agent combines statistics and contact lookups.

**Step 1: Search for budget-related memories**
```
Tool: search_memories
Input: {
  "query": "budget financial spending",
  "limit": 50
}
```

**Step 2: Analyze the entities in the results**

The agent counts person entities across all returned memories:

> "Based on your memory, the people you discuss budget topics with most are:
> 1. **John Smith** (23 mentions) -- mostly via email and Slack
> 2. **Sarah Chen** (15 mentions) -- primarily in email threads
> 3. **Mike Johnson** (8 mentions) -- WhatsApp group discussions"

## "Is there any conflicting information about the contract value?"

The agent leverages the factuality system.

**Step 1: Search for contract-related memories**
```
Tool: search_memories
Input: {
  "query": "contract value amount price",
  "limit": 20
}
```

**Step 2: Check factuality labels**

The agent examines the factuality field of each result:

> "I found a potential conflict in your memory:
> - **Email from Sarah** (Jan 15, FACT): 'The contract value is $250,000'
> - **Slack message from Mike** (Jan 18, UNVERIFIED): 'I heard the contract is closer to $300,000'
>
> The email from Sarah has higher trust (gmail: 0.95) and is labeled as FACT. Mike's Slack message is UNVERIFIED. You may want to confirm with Sarah."

## "What was I doing last Tuesday?"

The agent searches across all source types for a specific time period.

**Step 1: Search with time context**
```
Tool: search_memories
Input: {
  "query": "Tuesday February 25",
  "limit": 20
}
```

**Step 2: Supplement with location data**
```
Tool: search_memories
Input: {
  "query": "location February 25",
  "sourceType": "location",
  "limit": 10
}
```

**Step 3: Check photos**
```
Tool: search_memories
Input: {
  "query": "February 25",
  "sourceType": "photo",
  "limit": 10
}
```

The agent combines all results:

> "Here's what I found for last Tuesday (Feb 25):
> - **9:00 AM** -- You were at the office (OwnTracks location)
> - **10:30 AM** -- Email thread about the product roadmap with Sarah
> - **12:00 PM** -- Photo at a restaurant (Immich, tagged: you + John)
> - **2:00 PM** -- Slack discussion in #engineering about the API migration
> - **5:30 PM** -- WhatsApp message to family group about dinner plans"

## "Show me everything about my relationship with Acme Corp"

The agent performs a broad entity search and contact correlation.

**Step 1: Search by organization name**
```
Tool: search_memories
Input: {
  "query": "Acme Corp",
  "limit": 30
}
```

**Step 2: Find contacts associated with Acme**
```
Tool: search_contacts
Input: {
  "query": "Acme"
}
```

**Step 3: For key contacts, get their memory history**
```
Tool: get_contact_memories
Input: {
  "contactId": "acme-contact-uuid"
}
```

The agent builds a comprehensive picture combining emails, meetings, messages, and contact metadata.
