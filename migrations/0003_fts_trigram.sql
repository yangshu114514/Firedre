-- Firedre 0003：posts_fts 全文索引由 unicode61 切换为 trigram 分词（中文子串检索）
-- 背景：unicode61 按词切分、不识别中文，搜索「湿巾」命中不了「买了一包湿巾」；
--       trigram 按 3 字符滑窗索引，可命中任意位置的 3 字及以上子串（2 字查询命中为 0 是 FTS5 trigram 硬限制，由服务端 LIKE 通道兜底）。
-- 幂等：可重复应用，重复执行收敛到同一终态（列结构不变：slug UNINDEXED, title, excerpt, content）。
--
-- 重建策略：「新建 posts_fts_new → 按 rowid 覆盖式拷贝 → DROP 旧表 → 改名」（不使用临时普通表）。
-- 每一步都可安全重跑：
--   * 第 1 步兜底空壳 + 第 2 步 IF NOT EXISTS：任意中断态下目标表都存在，第 3 步的 SELECT 恒可用；
--   * 第 3 步 INSERT OR REPLACE 按 rowid 覆盖写入：重复应用不会把行数翻倍；
--   * 破坏性操作（DROP）排在拷贝成功之后，拷贝失败时旧表原样保留；
--   * 「DROP 后、RENAME 前」中断：重跑时第 1 步补出的 unicode61 空壳拷贝 0 行，
--     不会清掉 posts_fts_new 里已有的数据，最后 RENAME 恢复；
--   * 选此策略而非「COPY 到临时普通表再重建」：后者在「旧表已 DROP、新表未建」中断时，
--     重跑要么因 SELECT 不存在的表直接卡死，要么需要先清空临时表（唯一副本被清空）或回插产生重复 slug。

-- 1) 兜底：若 posts_fts 缺失（上次迁移中途失败），按 0001 的 unicode61 定义补一个空壳，
--    保证第 3 步 SELECT 可用；正常库中该表已存在，本句为 IF NOT EXISTS 空操作
CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
  slug UNINDEXED,
  title,
  excerpt,
  content,
  tokenize = 'unicode61'
);

-- 2) 新建 trigram 目标表（上次中断已建过则复用，由第 3 步保证数据正确）
CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts_new USING fts5(
  slug UNINDEXED,
  title,
  excerpt,
  content,
  tokenize = 'trigram'
);

-- 3) 数据搬移：按 rowid 覆盖式拷贝（重复应用不产生重复行）
INSERT OR REPLACE INTO posts_fts_new (rowid, slug, title, excerpt, content)
SELECT rowid, slug, title, excerpt, content FROM posts_fts;

-- 4) 删除旧表（FTS5 连同 _content/_idx/_data/_docsize/_config 影子表一并删除）
DROP TABLE posts_fts;

-- 5) 改名为正式表名（虚拟表改名会连带改名其影子表）
ALTER TABLE posts_fts_new RENAME TO posts_fts;
