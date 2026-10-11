-- 0005: 权限体系建表（补 10-06 f2647ec 权限功能缺失的 DDL）
-- perms.ts 引用：user_permissions / permission_requests
-- 幂等：CREATE TABLE/INDEX IF NOT EXISTS，可重复应用

-- 已授予权限点（审批通过后写入；撤销即删行）
CREATE TABLE IF NOT EXISTS user_permissions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  perm TEXT NOT NULL,                  -- 权限点 id（PERM_CATALOG，如 post:create）
  granted_by TEXT NOT NULL DEFAULT '', -- 审批人（admin username 或 user name）
  granted_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, perm)          -- ON CONFLICT(user_id, perm) 幂等授予
);
CREATE INDEX IF NOT EXISTS idx_user_permissions_perm ON user_permissions(perm);

-- 权限申请单（pending → approved/denied；同权限点 pending 不重复建单由代码保证）
CREATE TABLE IF NOT EXISTS permission_requests (
  id TEXT PRIMARY KEY,                 -- crypto.randomUUID()
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  perm TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','denied')),
  note TEXT NOT NULL DEFAULT '',
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_by TEXT,
  reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_perm_requests_user ON permission_requests(user_id, status);
CREATE INDEX IF NOT EXISTS idx_perm_requests_status ON permission_requests(status, requested_at DESC);
