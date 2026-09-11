# Scenario run: greenfield

**Type:** greenfield
**Requirement:** Build the core URL shortener: create a short link, redirect by code with click tracking, and expose per-code click analytics.

## What was built
- `POST /links` -- create a short link (optional custom alias / expiry)
- `GET /:code` -- redirect to the target URL, records a click event
- `GET /:code/stats` -- click count + last-access time for a code

## Persistence
SQLite (`src/target-project/data/aegis.db`), tables `links` and `click_events`.

## Notes
Click analytics are recorded asynchronously via an in-process event bus rather
than inline in the redirect handler, to keep the redirect path fast.
