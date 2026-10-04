-- Firedre 用户系统迁移（与 admin_users 完全隔离，来源：halo-migration/DESIGN-USER-SYSTEM.md B.3）
-- 幂等：CREATE TABLE/INDEX IF NOT EXISTS，可重复应用
-- 含用户三表（users/oauth_accounts/email_verifications）+ 评论/点赞两表（同 B.3 全文，为后续模块预置）

-- ========== 用户系统（与 admin_users 完全隔离） ==========
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,                 -- 随机 id（crypto.randomUUID()）
  email TEXT NOT NULL,                 -- 统一小写存储
  email_verified INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,                  -- 显示昵称（评论用）
  password TEXT NOT NULL DEFAULT '',   -- bcrypt $2b$；OAuth 用户为空串
  avatar TEXT NOT NULL DEFAULT '',     -- 头像 URL（OAuth 可带回）
  bio TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user',   -- 预留（仅 user；不授予任何后台能力）
  banned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS oauth_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('github','google')),
  provider_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider, provider_user_id)
);
CREATE INDEX IF NOT EXISTS idx_oauth_user ON oauth_accounts(user_id);

-- 验证邮件：明文 token 只出现在邮件链接，库内存哈希
CREATE TABLE IF NOT EXISTS email_verifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,            -- sha256(token)
  purpose TEXT NOT NULL CHECK (purpose IN ('signup','reset')),
  expires_at TEXT NOT NULL,            -- 24h（signup）/ 1h（reset）
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ev_user ON email_verifications(user_id, purpose);

-- ========== 评论（登录 + 匿名统一模型，后续评论模块使用） ==========
-- target 不设 FK：既可为文章 slug，也可为 'guestbook'/'dynamic:<id>' 等伪目标
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  target TEXT NOT NULL,                -- '/posts/<slug>' 用 slug；或 'guestbook'、'dynamic:<id>'
  parent_id TEXT REFERENCES comments(id) ON DELETE CASCADE,  -- 仅一级回复
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,      -- NULL = 匿名
  guest_name TEXT NOT NULL DEFAULT '', -- 匿名必填昵称；登录用户显示 users.name
  guest_email TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','spam','deleted')),
  ip TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_target ON comments(target, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(status, created_at DESC);

-- ========== 点赞 ==========
CREATE TABLE IF NOT EXISTS post_likes (
  post_slug TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (post_slug, user_id)
);
CREATE INDEX IF NOT EXISTS idx_likes_slug ON post_likes(post_slug);
