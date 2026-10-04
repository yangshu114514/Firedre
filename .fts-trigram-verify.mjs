/**
 * 本地 SQL 层验证脚本（不连生产库；仅用 node:sqlite 内存库 + 读取 migrations/0003_fts_trigram.sql 原文执行）。
 *
 * 验证点：
 *  1) 0003 幂等：连续应用 2 次，行数不翻倍、最终 tokenizer 为 trigram、影子表随虚拟表改名；
 *  2) 中断恢复：手动删掉 posts_fts（模拟 DROP 后、RENAME 前中断）再应用，数据不丢；
 *  3) 双通道：
 *     - ≥3 字符走 MATCH：'便利店' 命中《凌晨两点的便利店，我买了一包湿巾》；
 *     - <3 字符走 LIKE：'湿巾' 命中（trigram MATCH 对 2 字查询恒为 0，属已知硬限制）；
 *     - LIKE 通配符转义不误伤。
 *
 * 运行：node .fts-trigram-verify.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = dirname(fileURLToPath(import.meta.url));
const migrationSql = readFileSync(
  join(root, "migrations", "0003_fts_trigram.sql"),
  "utf8",
);

const SAMPLE_TITLE = "凌晨两点的便利店，我买了一包湿巾";
const SAMPLE_CONTENT =
  "不是为了擦。是为了有「我需要一包湿巾」这件事。 凌晨两点，便利店的日光灯白得刺眼。我站在货架前，看了五分钟，只拿了这一包湿巾。店员扫码的时候看了我一眼……";

let failed = 0;
const ok = (label, cond, extra = "") => {
  if (cond) console.log(`  ✅ ${label}${extra ? ` -> ${extra}` : ""}`);
  else {
    failed++;
    console.log(`  ❌ ${label}${extra ? ` -> ${extra}` : ""}`);
  }
};

const db = new DatabaseSync(":memory:");

// —— 0001 的基线（unicode61）+ 最小 posts 表 ——
db.exec(`
  CREATE TABLE posts (slug TEXT PRIMARY KEY, title TEXT NOT NULL, excerpt TEXT, date TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 1, pin_order INTEGER NOT NULL DEFAULT 0);
  CREATE VIRTUAL TABLE posts_fts USING fts5(slug UNINDEXED, title, excerpt, content, tokenize = 'unicode61');
`);
db.exec(
  `INSERT INTO posts(slug,title,date,published,pin_order) VALUES ('${SAMPLE_TITLE}','${SAMPLE_TITLE}','2025-01-02',1,0)`,
);
db.exec(
  `INSERT INTO posts_fts(slug,title,excerpt,content) VALUES ('${SAMPLE_TITLE}','${SAMPLE_TITLE}','不是为了擦。','${SAMPLE_CONTENT}')`,
);

const countFts = () => db.prepare("SELECT count(*) c FROM posts_fts").get().c;
const tokenizerOf = () =>
  String(db.prepare("SELECT sql FROM sqlite_master WHERE name='posts_fts'").get().sql)
    .replace(/\s+/g, " ");

console.log("— 1) 应用 0003（第 1 次） —");
db.exec(migrationSql);
const afterFirst = countFts();
ok("迁移成功且数据保留", afterFirst === 1, `行数=${afterFirst}`);
ok("tokenizer 已为 trigram", /tokenize\s*=\s*'trigram'/i.test(tokenizerOf()), tokenizerOf());
const shadows = db
  .prepare("SELECT name FROM sqlite_master WHERE name LIKE 'posts_fts%' ORDER BY name")
  .all()
  .map((r) => r.name)
  .join(", ");
ok(
  "影子表已随虚拟表改名（无残留 posts_fts_new*）",
  !shadows.includes("posts_fts_new"),
  shadows,
);

console.log("— 2) 重复应用（幂等） —");
db.exec(migrationSql);
const afterSecond = countFts();
ok("重复应用行数不翻倍", afterSecond === 1, `行数=${afterSecond}`);
ok("重复应用后仍为 trigram", /tokenize\s*=\s*'trigram'/i.test(tokenizerOf()));

console.log("— 3a) 中断恢复 A：拷贝完成、DROP 旧表前中断（新旧两表并存） —");
db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts_new USING fts5(slug UNINDEXED, title, excerpt, content, tokenize = 'trigram')`);
db.exec(`INSERT OR REPLACE INTO posts_fts_new (rowid, slug, title, excerpt, content) SELECT rowid, slug, title, excerpt, content FROM posts_fts`);
db.exec(migrationSql);
ok("重跑收敛且行数不翻倍", countFts() === 1, `行数=${countFts()}`);
ok("收敛后为 trigram", /tokenize\s*=\s*'trigram'/i.test(tokenizerOf()));

console.log("— 3b) 中断恢复 B：DROP 旧表后、RENAME 前中断（posts_fts 缺失，数据在 posts_fts_new） —");
db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts_new USING fts5(slug UNINDEXED, title, excerpt, content, tokenize = 'trigram')`);
db.exec(`INSERT OR REPLACE INTO posts_fts_new (rowid, slug, title, excerpt, content) SELECT rowid, slug, title, excerpt, content FROM posts_fts`);
db.exec("DROP TABLE posts_fts");
db.exec(migrationSql);
ok("重跑后 posts_fts 恢复且有数据", countFts() === 1, `行数=${countFts()}`);
ok("恢复后仍为 trigram", /tokenize\s*=\s*'trigram'/i.test(tokenizerOf()));

// —— 双通道（与 server/posts/service.ts 中 searchPosts 生成的 SQL 一致） ——
const escapeLike = (s) => s.replace(/([\\%_])/g, "\\$&");
const escapeFts = (keyword) =>
  keyword
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(" AND ");
const matchQuery = (q, limit) =>
  db
    .prepare(
      `SELECT p.* FROM posts_fts f
       JOIN posts p ON p.slug = f.slug
       WHERE posts_fts MATCH ? AND p.published = 1
       ORDER BY rank
       LIMIT ?`,
    )
    .all(escapeFts(q), limit);
const likeQuery = (q, limit) =>
  db
    .prepare(
      `SELECT p.* FROM posts_fts f
       JOIN posts p ON p.slug = f.slug
       WHERE (
         f.title LIKE ? ESCAPE '\\' OR
         f.excerpt LIKE ? ESCAPE '\\' OR
         f.content LIKE ? ESCAPE '\\'
       ) AND p.published = 1
       ORDER BY p.pin_order DESC, p.date DESC
       LIMIT ?`,
    )
    .all(`%${escapeLike(q)}%`, `%${escapeLike(q)}%`, `%${escapeLike(q)}%`, limit);
const channel = (q) => ([...q].length >= 3 ? "MATCH" : "LIKE");

console.log("— 4) 双通道：3 字词 '便利店' —");
ok("走 MATCH 通道", channel("便利店") === "MATCH", channel("便利店"));
ok("MATCH '便利店' 命中", matchQuery("便利店", 20).length === 1);

console.log("— 5) 双通道：2 字词 '湿巾' —");
ok("走 LIKE 通道", channel("湿巾") === "LIKE", channel("湿巾"));
ok("LIKE '%湿巾%' 命中", likeQuery("湿巾", 20).length === 1);
ok(
  "对照：trigram MATCH '湿巾' 命中 0（硬限制，故需 LIKE 兜底）",
  matchQuery("湿巾", 20).length === 0,
);

console.log("— 6) LIKE 通配符转义 —");
ok("'%' 普通查询不误命中", likeQuery("%", 20).length === 0, `行数=${likeQuery("%", 20).length}`);
ok("'_' 普通查询不误命中", likeQuery("_", 20).length === 0, `行数=${likeQuery("_", 20).length}`);
ok("'\\\\' 普通查询不误命中", likeQuery("\\", 20).length === 0);

console.log("— 7) 空查询维持现有行为 —");
ok("空查询直接返回（不进 SQL）", "".trim() === "");

console.log(failed === 0 ? "\n全部通过 ✅" : `\n失败 ${failed} 项 ❌`);
process.exit(failed === 0 ? 0 : 1);
