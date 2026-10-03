# Upload form and task scrolling

Local disposable fixtures, captured on October 3, 2026. No production data or credentials.

- `empty-form-progress.jpg`: extra top spacing in the empty upload card, tighter import-source spacing, and plain progress bars (402 × 874 viewport override).
- `form-and-task.jpg`: the Pixiv form remains expanded alongside an expanded task (402 × 874 viewport override).
- `pixiv-sticky.jpg`: after the form leaves the viewport, its compact source button and task-list label stay above the scrolling cards (402 × 600 viewport override).
- `task-password.jpg`, `task-duplicate.jpg`, `task-failed.jpg`, `task-completed.jpg`: task borders, status summaries and notices use consistent warning, failure and success colors (402 × 874 viewport override).

Verified tab scroll restoration without replaying task entrance animations; card reveal starting alongside expansion, above the bottom navigation and below the floating header; fixed 12px task titles, 16px source icons and 6px heading padding; oversized card heading alignment; returning to the retained form draft; canceling the draft without an intermediate collapsed state.

Verified that canceling and acknowledging completed tasks retain the exit animation and leave all tasks collapsed. The existing tests cover preserving another expanded task when a different task is removed. After verification, all local fixture tasks and packs were removed and the temporary upload throttle was disabled for manual E2E testing.

Restored the shared tag picker bottom sheet for archive, folder, Pixiv and MEGA drafts. `compact-pixiv-form.jpg`, `compact-mega-form.jpg`, `compact-archive-form.jpg`, and `compact-folder-form.jpg` show placeholder-only fields with accessible names at 402 × 874; `tag-selector.jpg` shows search and a selected disposable tag. Verified tag creation, confirmation, cancellation, reopening with retained selection, and Enter in the picker without submitting an upload. The picker sits outside the upload form and is portaled above the card and floating header. The temporary tag was removed after verification; no fixture upload was started.

`completed-task-previews.jpg` shows the shared pack processing result after uploading eight generated test images: six thumbnails plus View Pack and Done actions. The result component accepts only the pack ID and completion callback, independent of upload source, transfer progress, file details or retry controls. Completed cards no longer show the green explanatory message or the transferred-file count. Verified loaded images, thumbnail navigation and restored results after returning to the upload tab. Only disposable test tasks and packs were removed after verification.
