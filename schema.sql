CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- الحسابات (التسجيل بالبريد الإلكتروني)
CREATE TABLE IF NOT EXISTS users (
  id              BIGSERIAL PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  bio             TEXT,
  avatar          TEXT,
  logo            TEXT,
  lang            TEXT NOT NULL DEFAULT 'ar' CHECK (lang IN ('ar', 'en')),
  role            TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  blocked         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- رموز التحقق واستعادة كلمة المرور (مخزنة مشفّرة بالتجزئة)
CREATE TABLE IF NOT EXISTS email_codes (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  purpose     TEXT NOT NULL CHECK (purpose IN ('verify', 'reset')),
  expires_at  TIMESTAMPTZ NOT NULL,
  attempts    INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_email_codes_user ON email_codes (user_id, purpose);

-- الجلسات (الرمز نفسه لا يُخزَّن، بل تجزئته)
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

-- السجلات
CREATE TABLE IF NOT EXISTS records (
  id                  BIGSERIAL PRIMARY KEY,
  category            TEXT NOT NULL CHECK (category IN ('martyr', 'missing', 'detainee')),
  -- خاصة بالمعتقلين: released = مُفرج عنه ، missing = مفقود
  status              TEXT CHECK (status IN ('released', 'missing')),
  full_name           TEXT NOT NULL,
  name_key            TEXT NOT NULL,
  event_date          DATE NOT NULL,
  governorate         TEXT NOT NULL,
  city                TEXT,
  area                TEXT,
  place_of_detention  TEXT,
  notes               TEXT,
  contact             TEXT,
  photo               TEXT,
  user_id             BIGINT REFERENCES users (id) ON DELETE SET NULL,
  review_status       TEXT NOT NULL DEFAULT 'pending'
                      CHECK (review_status IN ('pending', 'approved', 'rejected', 'merged')),
  merged_into         BIGINT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT detainee_needs_status CHECK (category <> 'detainee' OR status IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_records_list ON records (category, review_status, event_date DESC);
CREATE INDEX IF NOT EXISTS idx_records_name_trgm ON records USING GIN (name_key gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_records_governorate ON records (governorate);
CREATE INDEX IF NOT EXISTS idx_records_user ON records (user_id);

-- الاسم الواحد مرة واحدة لكل مستخدم في كل فئة
CREATE UNIQUE INDEX IF NOT EXISTS uniq_user_name
  ON records (user_id, name_key, category)
  WHERE user_id IS NOT NULL AND review_status IN ('pending', 'approved');

-- إعدادات الموقع (مربع الترحيب الذي يكتبه المشرف)
CREATE TABLE IF NOT EXISTS site_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
