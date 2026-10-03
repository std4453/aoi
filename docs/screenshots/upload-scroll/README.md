# Upload form and task scrolling

Local disposable fixtures, captured on October 3, 2026. No production data or credentials.

- `empty-form-progress.jpg`: extra top spacing in the empty upload card, tighter import-source spacing, and plain progress bars (402 × 874 viewport override).
- `form-and-task.jpg`: the Pixiv form remains expanded alongside an expanded task (402 × 874 viewport override).
- `pixiv-sticky.jpg`: after the form leaves the viewport, its compact source button and task-list label stay above the scrolling cards (402 × 600 viewport override).
- `task-password.jpg`, `task-duplicate.jpg`, `task-failed.jpg`, `task-completed.jpg`: task borders, status summaries and notices use consistent warning, failure and success colors (402 × 874 viewport override).

Verified tab scroll restoration without replaying task entrance animations; card reveal starting alongside expansion, above the bottom navigation and below the floating header; fixed 12px task titles, 16px source icons and 6px heading padding; oversized card heading alignment; returning to the retained form draft; canceling the draft without an intermediate collapsed state.

Verified that canceling and acknowledging completed tasks retain the exit animation and leave all tasks collapsed. The existing tests cover preserving another expanded task when a different task is removed. After verification, all local fixture tasks and packs were removed and the temporary upload throttle was disabled for manual E2E testing.
