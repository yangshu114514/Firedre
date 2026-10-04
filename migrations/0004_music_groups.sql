-- 0004: 音乐分组（自动嗅探架构，用户确认方案）
-- D1 只存「显式分组归属」；桶内文件为唯一事实来源：
--   渲染时 List R2 music/ 前缀 ∩ 分组表 → 各组实际曲目；
--   未归属文件 → 动态「未分组」（不落库）；
--   文件删除 → 自动从所有组消失（交集为空）。
CREATE TABLE IF NOT EXISTS music_groups (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL UNIQUE,
	sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS music_group_items (
	group_id INTEGER NOT NULL REFERENCES music_groups(id) ON DELETE CASCADE,
	filename TEXT NOT NULL,
	UNIQUE (group_id, filename)
);

CREATE INDEX IF NOT EXISTS idx_music_group_items_group ON music_group_items (group_id);
