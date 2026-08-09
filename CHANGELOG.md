# Changelog

All notable changes to this project will be documented in this file.

## 0.1.9 (2026-04-10)

### Fixed
- Host control channel is now always included in the effective allowed channel list,
  resolving a catch-22 where `/login` could not be used anywhere: the host channel
  was not whitelisted, and the OAuth flow components required the host channel.
- OAuth login completion now syncs credentials to multi-auth rotation via
  `getProviderStatus` + `autoActivatePreferredCredentials`, so newly logged-in
  accounts appear in `/multi-auth status` immediately instead of waiting for the
  next `acquireCredential` call. Gracefully no-ops when multi-auth plugin is absent.
- Direct `/login provider:X key:Y` slash-command path now calls
  `addApiKeyCredential()` to sync with multi-auth rotation, matching the behavior
  of the modal-based API key flow. Gracefully no-ops when multi-auth plugin is absent.
- Round-robin `activeIndex` now advances after every non-manual credential selection
  across all rotation modes (round-robin, usage-based, balancer). Previously,
  usage-based and balancer modes left `activeIndex` on the credential just used,
  causing the round-robin fallback in `getRoundRobinCandidateIndex` to re-scan
  from the same credential and pick it again when usage data was stale.
- `/login` without options now checks `isHostControlChannel` before rendering
  the OAuth provider select menu, giving an early clear message pointing to the
  host channel instead of failing mid-flow when the user picks a provider.

## 0.4.0 (2026-08-09)

### Changed
- Simplified Discord live rendering to avoid extra chat clutter.
- Removed interactive choice dropdowns from normal response rendering.
- Removed per-tool detail buttons from normal response rendering.
- Improved README wording for clearer setup and runtime guidance.

### Fixed
- New messages now interrupt active runs in the same thread instead of allowing overlapping responses.
- DM conversations now follow the same latest-message-wins interruption behavior.
- Live run state updates now refresh model, thinking, and context usage metadata while a response is streaming.

### Added
- Added visible rendering for skill usage in live Discord responses.
- Added visible rendering for subagent usage in live Discord responses.
- Added multi-auth balancer with key and global distributors for credential rotation.
- Added cascade state tracking and picord config adapter for multi-auth.
