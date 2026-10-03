# Upload task state styles

Captured on 2026-10-04 with the actual task card and result components, using isolated mock task/file data. These are style fixtures, not evidence of real transfers or remote imports. No test tasks or packs were added to the user's development service.

- [Transfer and pause](01-transfer.jpg): initial folder upload (0/8), partial upload, archive upload, MEGA/Pixiv download, pause, expanded file details, cancellation confirmation.
- [Processing](02-processing.jpg): preparing, queued/running extraction, queued/running verification, queued/running preview generation.
- [Attention and failure](03-attention.jpg): folder/archive reselection, archive/share passwords, incorrect password, duplicate confirmation, extraction/login/network/file upload failures.
- [Results](04-results.jpg): loading thumbnail list, loading images, ready thumbnails, empty result, list failure and individual image failure reusing the loading skeleton. Loading fixtures are held in their respective states; preview failures add no warning or retry action.
- [Collapsed](05-collapsed.jpg): all nine task states.

The shared state contract defines each status's label, tone and content mode. Task notices use 12px text with 8px vertical padding. The file disclosure uses 12px text and a 20px control height; task content uses 8px gaps. Main actions retain the normal button size. Their shared row adds 4px above the body gap (12px total); file-details blocks compensate by -4px to preserve their existing spacing. This aligns the space from progress bars to the next visible content, rather than to an invisible hit area. Password submission reads “提交并继续”. Queued and running stages share “准备中 / 解包中 / 校验中 / 生成预览中”; queued state and measured-progress rules are unchanged.

Separate local verification of the built application held and released thumbnail API and image responses. At a 402px viewport, the six-thumbnail grid remained 211.328px high through list loading, image loading, and completion. All six skeletons persisted until their images loaded. `npm run check`: 128 passed, 0 failed, 0 skipped.
