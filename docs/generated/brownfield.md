# Scenario run: brownfield

**Type:** brownfield
**Requirement:** Add tiered rate limiting so premium partner clients get higher limits than standard clients.

## Codebase reasoning
Read the existing `rateLimit.ts` and `server.ts` before proposing a change (see the design stage's
audit record for the exact finding).

## What changed
- `links.client_tier` column added ('standard' | 'premium', default 'standard')
- `POST /links` accepts an optional `clientTier`
- `GET /:code` is now rate-limited per tier: standard = 60 req/min, premium = 600 req/min

## Compatibility
Existing standard-tier behavior is unchanged; premium is strictly additive.
