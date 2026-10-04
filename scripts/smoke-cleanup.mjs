// 冒烟后清理种子数据
import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";
const db = new DatabaseSync("D:/DSH/firedre/.wrangler/local-state/local-d1.sqlite");
db.exec("PRAGMA journal_mode = WAL");
db.prepare("DELETE FROM comments WHERE target = 'smoke-comment-post'").run();
db.prepare("DELETE FROM post_likes WHERE post_slug = 'smoke-comment-post'").run();
db.prepare("DELETE FROM users WHERE email IN ('smoke-comment@example.com','smoke-unverified@example.com')").run();
db.prepare("DELETE FROM posts WHERE slug = 'smoke-comment-post'").run();
// 冒烟期间注入的 comment 设置还原（原库中本无该 key）
db.prepare("DELETE FROM site_settings WHERE key = 'comment'").run();
try { rmSync("D:/DSH/firedre/.wrangler/local-state/local-r2/posts/smoke-comment-post.md"); } catch {}
const left1 = db.prepare("SELECT COUNT(*) AS n FROM comments WHERE target LIKE 'smoke%'").get().n;
const left2 = db.prepare("SELECT COUNT(*) AS n FROM users WHERE email LIKE 'smoke-%'").get().n;
const left3 = db.prepare("SELECT COUNT(*) AS n FROM posts WHERE slug LIKE 'smoke%'").get().n;
console.log("残留 smoke 评论:", left1, "用户:", left2, "文章:", left3);
db.close();
