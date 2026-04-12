CREATE TABLE IF NOT EXISTS packs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  original_size INTEGER NOT NULL,
  original_format TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'uploading',
  image_count INTEGER DEFAULT 0,
  video_count INTEGER DEFAULT 0,
  total_images_size INTEGER DEFAULT 0,
  total_videos_size INTEGER DEFAULT 0,
  error_message TEXT,
  archive_password TEXT,
  compressed_size INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  options TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  progress INTEGER DEFAULT 0,
  options TEXT,
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  pack_id TEXT,
  filename TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  offset INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'uploading',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_packs_created_at ON packs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_pack_id ON jobs(pack_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_presets_default ON presets(is_default) WHERE is_default = 1;

-- Tags
CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Pack-Tag association (many-to-many)
CREATE TABLE IF NOT EXISTS pack_tags (
  pack_id TEXT NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (pack_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_pack_tags_tag_id ON pack_tags(tag_id);
