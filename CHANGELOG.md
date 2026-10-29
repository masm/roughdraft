# Changelog

## Unreleased

- Persist local review completion receipts and opening contexts across server restarts, fence stale scoped requests, and recover interrupted overall-comment handoffs without duplicate feedback. Requires Node.js 22.13.0 or newer.

- Allow replying to YAML-backed replies by resolving their parent thread anchor, including replies under suggestions and deeper nesting after reload.

- Preserve paragraph breaks and Markdown-looking text inside review comments through save and reload, including comments on list items.

- Preserve structured YAML reply endmatter when editing documents with older inline review metadata, and show those replies and nested replies in their review threads after reopening.
