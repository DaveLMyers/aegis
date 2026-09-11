# Scenario run: ambiguous

**Type:** ambiguous
**Requirement (as given):** "Improve the experience for our premium/partner clients."

## How the ambiguity was resolved
Candidate interpretations considered:
- Higher rate limits for premium clients -- already delivered by the brownfield tiered-rate-limit change.
- Custom vanity short codes for premium clients -- already generally supported via the alias field on link creation.
- A support/SLA commitment for premium clients -- not an API-level change; out of scope for a system that only builds software artifacts.
- Richer analytics for premium clients, e.g. a referrer breakdown instead of just a raw click count -- not yet covered by prior work.

**Chosen interpretation:** Richer analytics for premium clients: GET /:code/stats returns a referrer breakdown for premium-tier links (standard-tier responses are unchanged).

**Assumptions recorded:**
- The two most literal readings (rate limits, vanity aliases) are already covered by prior work, so treating this ask as "another one of those" would add no new value -- interpreted it as pointing at an uncovered dimension instead.
- "Improve the experience" is read as an API-visible capability a client can actually call, not an SLA/support commitment, since this system only produces software artifacts.
- The new capability is scoped to premium-tier links only, mirroring the differentiated-treatment pattern already established by the tiered rate limiter.

## What changed
`GET /:code/stats` now includes a `referrerBreakdown` array for premium-tier links only.
