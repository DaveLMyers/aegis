## Summary

<!-- What changed, and why -- the diff already shows what; this is for why. -->

## Test plan

<!-- A checklist of what was actually verified, not what should theoretically pass. -->
- [ ] `npx tsc --noEmit` clean
- [ ] `npm test` fully green
- [ ] If this touches the orchestrator/playbooks: full 3-scenario regression rebuild from a clean slate
- [ ] For anything claiming to work against a real external system (GitHub, a live API, etc.): verified end-to-end for real, not only unit-tested
