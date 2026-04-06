# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

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
