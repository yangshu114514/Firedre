// 冒烟测试（评论系统 + 文章点赞）：直插种子数据 + HMAC 自签会话 + fetch 全流程
// 本地本地 sqlite 与 .wrangler/local-state 由 cf-dev-shim 建立，迁移自动执行。
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHmac } from "node:crypto";

const root = "D:/DSH/firedre";
const stateDir = join(root, ".wrangler", "local-state");
const BASE = "http://127.0.0.1:4405";
const SECRET = "dev-user-session-secret-firedre-local-0000";

const db = new DatabaseSync(join(stateDir, "local-d1.sqlite"));
db.exec("PRAGMA journal_mode = WAL");

// ── 0. 清理旧测试数据（可重复执行）──
const SLUG = "smoke-comment-post";
const EMAIL = "smoke-comment@example.com";
db.prepare("DELETE FROM comments WHERE target = ?").run(SLUG);
db.prepare("DELETE FROM post_likes WHERE post_slug = ?").run(SLUG);
db.prepare("DELETE FROM users WHERE email IN (?, 'smoke-unverified@example.com')").run(EMAIL);
db.prepare("DELETE FROM comments WHERE guest_name IN ('路人甲','路人乙','路人丙','路人丁')").run();
db.prepare("DELETE FROM rate_limits WHERE key LIKE 'comment:%'").run();
// 开启原生评论（settings comment 组 JSON）并 bump 版本，防 HTML 缓存命中旧渲染
db.prepare(
  "INSERT OR REPLACE INTO site_settings (key, value, updated_at) VALUES ('comment', '{\"enabled\":true,\"type\":\"native\"}', datetime('now'))",
).run();
db.prepare(
  "INSERT OR REPLACE INTO site_settings (key, value, updated_at) VALUES ('__firedre_settings_version', 'smoke-' || datetime('now'), datetime('now'))",
).run();
db.prepare("DELETE FROM posts WHERE slug = ?").run(SLUG);

// ── 1. 种子：已验证登录用户 + 已发布文章（正文入 local-r2）──
const uid = "smoke-user-0001";
db.prepare(
  `INSERT INTO users (id, email, email_verified, name, password, avatar, role, banned)
   VALUES (?, ?, 1, '冒烟用户', '', '', 'user', 0)`,
).run(uid, EMAIL);

const r2Key = "posts/" + SLUG + ".md";
mkdirSync(join(stateDir, "local-r2", "posts"), { recursive: true });
const md = `---\ntitle: 冒烟测试文章\ndescription: 评论点赞冒烟\ndate: 2025-01-01\ncategories: 测试\n---\n\n# 冒烟测试文章\n\n正文内容，用于评论点赞冒烟。\n`;
writeFileSync(join(stateDir, "local-r2", r2Key), md, "utf8");
db.prepare(
  `INSERT INTO posts (slug, title, excerpt, date, published, password, fm_json, words, minutes, r2_key)
   VALUES (?, '冒烟测试文章', '评论点赞冒烟', '2025-01-01', 1, '', '{}', 100, 1, ?)`,
).run(SLUG, r2Key);
console.log("[seed] 用户+文章已插入");

// ── 2. 自签 user_session（HMAC，与 server/auth/userSession.ts 同算法）──
function b64url(input) {
  return Buffer.from(input, "utf8").toString("base64url");
}
const payload = b64url(
  JSON.stringify({ u: uid, exp: Date.now() + 3600_000, role: "user" }),
);
const sig = createHmac("sha256", SECRET).update(payload).digest("base64url");
const TOKEN = `${payload}.${sig}`;
const USER_COOKIE = `user_session=${encodeURIComponent(TOKEN)}`;
console.log("[seed] user_session 自签完成");

// ── 3. 请求工具 ──
let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? "  | " + extra : ""}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? "  | " + extra : ""}`);
  }
}
async function req(method, path, { cookie, body, origin } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["Sec-Fetch-Site"] = "same-origin";
  }
  if (origin) headers.Origin = origin;
  const resp = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  return resp;
}

// ── 场景 1：匿名评论 → pending ──
console.log("[场景1] 匿名评论应 pending");
{
  const r = await req("POST", "/api/comments/", {
    body: { target: SLUG, content: "匿名冒烟评论一", guestName: "路人甲" },
  });
  const d = await r.json().catch(() => ({}));
  check("HTTP 200", r.status === 200, `status=${r.status}`);
  check("status=pending", d.status === "pending", `got=${d.status}`);
  check("message 提示审核", (d.message || "").includes("审核"));
  const row = db
    .prepare("SELECT status, user_id, guest_name FROM comments WHERE id = ?")
    .get(d.comment?.id || "");
  check("落库 status=pending", row?.status === "pending");
  check("落库 匿名无 user_id", !row?.user_id);
}

// ── 场景 2：已验证登录评论 → approved 直发 ──
console.log("[场景2] 已验证登录评论应 approved");
{
  const r = await req("POST", "/api/comments/", {
    cookie: USER_COOKIE,
    body: { target: SLUG, content: "登录冒烟评论，直发" },
  });
  const d = await r.json().catch(() => ({}));
  check("HTTP 200", r.status === 200, `status=${r.status}`);
  check("status=approved", d.status === "approved", `got=${d.status}`);
  const row = db
    .prepare("SELECT status, user_id FROM comments WHERE id = ?")
    .get(d.comment?.id || "");
  check("落库 approved + user_id", row?.status === "approved" && row?.user_id === uid);
}

// ── 场景 2b：未验证登录用户被拒 ──
console.log("[场景2b] 未验证登录评论应 403 提示验证");
{
  const uid2 = "smoke-user-unverified";
  db.prepare(
    `INSERT INTO users (id, email, email_verified, name, password, avatar, role, banned)
     VALUES (?, 'smoke-unverified@example.com', 0, '未验证用户', '', '', 'user', 0)`,
  ).run(uid2);
  const p2 = b64url(
    JSON.stringify({ u: uid2, exp: Date.now() + 3600_000, role: "user" }),
  );
  const tok2 = `${p2}.${createHmac("sha256", SECRET).update(p2).digest("base64url")}`;
  const r = await req("POST", "/api/comments/", {
    cookie: `user_session=${encodeURIComponent(tok2)}`,
    body: { target: SLUG, content: "未验证用户的评论" },
  });
  const d = await r.json().catch(() => ({}));
  check("HTTP 403", r.status === 403, `status=${r.status}`);
  check("needVerify 标记", d.needVerify === true);
  check("提示完成邮箱验证", (d.message || "").includes("邮箱验证"));
}

// ── 场景 3：点赞 toggle 幂等 ──
console.log("[场景3] 登录点赞 toggle：加→减→加");
{
  const post = (r) => req("POST", "/api/likes/toggle/", { cookie: USER_COOKIE, body: { slug: SLUG } });
  const r1 = await post();
  const d1 = await r1.json().catch(() => ({}));
  check("第一次 liked=true", r1.status === 200 && d1.liked === true && d1.count === 1, JSON.stringify(d1));
  const r2 = await post();
  const d2 = await r2.json().catch(() => ({}));
  check("第二次取消 liked=false count=0", d2.liked === false && d2.count === 0);
  const r3 = await post();
  const d3 = await r3.json().catch(() => ({}));
  check("第三次再加 liked=true count=1", d3.liked === true && d3.count === 1);
  const n = db.prepare("SELECT COUNT(*) AS n FROM post_likes WHERE post_slug = ? AND user_id = ?").get(SLUG, uid).n;
  check("落库恰一行", Number(n) === 1);
  const anon = await req("GET", `/api/likes/?slug=${SLUG}`);
  const da = await anon.json().catch(() => ({}));
  check("匿名读 count=1 liked=false", da.count === 1 && da.liked === false && da.authenticated === false);
  const auth = await req("GET", `/api/likes/?slug=${SLUG}`, { cookie: USER_COOKIE });
  const du = await auth.json().catch(() => ({}));
  check("登录读 liked=true", du.liked === true && du.authenticated === true);
}

// ── 场景 4：匿名限流 3 条/10 分 → 第 4 条 429 ──
console.log("[场景4] 匿名第 4 条应 429");
{
  // 场景1 已用 1 条配额，再发 2 条补满 3
  const r2 = await req("POST", "/api/comments/", { body: { target: SLUG, content: "匿名冒烟评论二", guestName: "路人乙" } });
  const r3 = await req("POST", "/api/comments/", { body: { target: SLUG, content: "匿名冒烟评论三", guestName: "路人丙" } });
  check("第 2/3 条正常", r2.status === 200 && r3.status === 200, `${r2.status}/${r3.status}`);
  const r4 = await req("POST", "/api/comments/", { body: { target: SLUG, content: "第4条应被限流", guestName: "路人丁" } });
  const d4 = await r4.json().catch(() => ({}));
  check("HTTP 429", r4.status === 429, `status=${r4.status}`);
  check("限流文案", (d4.message || "").includes("频繁"));
  const n = db.prepare("SELECT COUNT(*) AS n FROM comments WHERE guest_name = '路人丁'").get().n;
  check("第 4 条未落库", Number(n) === 0);
}

// ── 场景 5：前台文章页渲染评论区 + 点赞按钮 ──
console.log("[场景5] 文章页渲染");
{
  const r = await req("GET", `/post/${SLUG}/`);
  const html = await r.text();
  check("HTTP 200", r.status === 200, `status=${r.status}`);
  check("含评论区容器", html.includes('id="post-comments"'));
  check("SSR 列表含已审核评论", html.includes("登录冒烟评论"));
  check("含点赞按钮 aria 标记", html.includes("aria-label=\"点赞本文\"") || html.includes("点赞本文"));
  check("含 SSR 点赞计数 1", /aria-pressed[\s\S]{0,200}>\s*<span[^>]*>1</.test(html) || html.includes(">1</span>"));
  check("含文章标题", html.includes("冒烟测试文章"));

  // 匿名 GET 评论列表（匿名观众只见 approved）
  const rl = await req("GET", `/api/comments/?target=${encodeURIComponent(SLUG)}`);
  const dl = await rl.json().catch(() => ({}));
  check("匿名列表只含 approved", rl.status === 200 && dl.items?.length === 1 && dl.items[0].status === "approved", `items=${dl.items?.length}`);

  // 登录可见性（D.3）：插入一条「自己的 pending」后，登录观众应见 approved + 自己的 pending
  db.prepare(
    "INSERT INTO comments (id, target, user_id, guest_name, content, status, created_at) VALUES ('smoke-own-pending', ?, ?, '', '我自己待审的评论', 'pending', datetime('now'))",
  ).run(SLUG, uid);
  const rl2 = await req("GET", `/api/comments/?target=${encodeURIComponent(SLUG)}`, { cookie: USER_COOKIE });
  const dl2 = await rl2.json().catch(() => ({}));
  check("登录列表含自己 pending", dl2.items?.length === 2, `items=${dl2.items?.length} total=${dl2.total}`);

  // 后台审核动作：直接走 service 同款 SQL 验证 moderate 语义（API 需管理员登录态）
  db.prepare("UPDATE comments SET status = 'approved' WHERE guest_name = '路人甲'").run();
  const rl3 = await req("GET", `/api/comments/?target=${encodeURIComponent(SLUG)}`);
  const dl3 = await rl3.json().catch(() => ({}));
  check("审核通过后匿名可见 2 条", dl3.items?.length === 2, `items=${dl3.items?.length}`);
}

// ── 场景 6：CSRF Origin 校验 ──
console.log("[场景6] 跨站 Origin 应 403");
{
  const r = await req("POST", "/api/likes/toggle/", {
    cookie: USER_COOKIE,
    body: { slug: SLUG },
    origin: "https://evil.example.com",
  });
  check("HTTP 403", r.status === 403, `status=${r.status}`);
}

console.log(`\n[结果] 通过 ${pass} / 失败 ${fail}`);
db.close();
process.exit(fail ? 1 : 0);
