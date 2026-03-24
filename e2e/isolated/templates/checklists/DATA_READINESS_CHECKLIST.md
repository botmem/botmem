# Data Readiness Checklist

## Global
- [ ] 2 users per mode with recovery keys available
- [ ] Anchors seeded:
  - BOTMEM_E2E_ANCHOR_GLOBAL_01
  - BOTMEM_E2E_ANCHOR_PROJECT_X
  - BOTMEM_E2E_ANCHOR_PERSON_ALI
- [ ] Data spans 24h / 7d / 30d+
- [ ] At least one contradictory/unverified sample
- [ ] At least 5 pinned memories

## Connector minimums
- [ ] Gmail: 20+ emails, 3+ threads, 3+ attachments
- [ ] Slack: channels + DM + thread + file/reaction
- [ ] WhatsApp: 1:1 + group + media
- [ ] Telegram: private/group + media
- [ ] iMessage: bridge reachable and history available
- [ ] Photos (Immich): 30+ assets, people tags, GPS
- [ ] Locations (OwnTracks): 20+ points, multi-day, 2+ places

## Runtime-interactive
- [ ] WhatsApp QR scan operator ready
- [ ] Telegram OTP operator ready
- [ ] Stripe webhook ngrok URL + secret ready (managed)
