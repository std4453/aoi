-- Selective content export from an attached private snapshot into a new catalog.
-- Explicit projections exclude secrets and future local-only columns by default.
-- Keep the catalog checks in protocol.ts and the protocol version in sync.
INSERT INTO main.packs (
  id, name, original_filename, original_size, original_format, status,
  image_count, video_count, total_images_size, total_videos_size, error_message,
  compressed_size, created_at, updated_at, structure_type, blurhashes,
  source_type, archive_md5
)
SELECT
  id, name, original_filename, original_size, original_format, status,
  image_count, video_count, total_images_size, total_videos_size, error_message,
  compressed_size, created_at, updated_at, structure_type, blurhashes,
  source_type, archive_md5
FROM source.packs
WHERE status IN ('extracted', 'generated');

INSERT INTO main.presets (id, name, is_default, options, created_at, updated_at)
SELECT id, name, is_default, options, created_at, updated_at FROM source.presets;

INSERT INTO main.tags (id, name, created_at)
SELECT id, name, created_at FROM source.tags;

INSERT INTO main.pack_tags (pack_id, tag_id)
SELECT pack_id, tag_id FROM source.pack_tags
WHERE pack_id IN (SELECT id FROM main.packs);

INSERT INTO main.pack_verifications (
  pack_id, version, status, fingerprint, file_count, total_bytes, checked_at,
  error, historical, next_status, previous_error, approved
)
SELECT
  pack_id, version, status, fingerprint, file_count, total_bytes, checked_at,
  error, historical, next_status, previous_error, approved
FROM source.pack_verifications
WHERE pack_id IN (SELECT id FROM main.packs);

INSERT INTO main.migrations (name, executed_at)
SELECT name, executed_at FROM source.migrations;
