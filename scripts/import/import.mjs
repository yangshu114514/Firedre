#!/usr/bin/env node
/**
 * Halo(Firefly) → Firedre（D1 + R2）数据导入脚本
 *
 * 用法：
 *   node import.mjs build   # 生成 out/ 中间产物（md + SQL batch + manifest），幂等
 *   node import.mjs r2      # 上传 R2 对象（posts×17 + about + spec），幂等覆盖
 *   node import.mjs d1      # 执行 D1 SQL batch（posts→taxonomy→fts→misc），幂等
 *   node import.mjs verify  # G-12 验证查询
 *   node import.mjs all     # build + r2 + d1 + verify
 *
 * 设计约束（见 REPORT-DATA-MODEL.md）：
 *  - fm_json 与 R2 md frontmatter 双源一致（同一对象序列化 + 回读校验）
 *  - FTS content = stripMarkdown 正文纯文本（复刻 server/posts/markdown.ts）
 *  - categories/tags = JSON 数组串；category 全部『默认分类』
 *  - 日期统一 'YYYY-MM-DD HH:mm:ss'；slug = 中文标题；r2_key = posts/<slug>.md
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", ".."); // D:\DSH\firedre
const SRC_POSTS = path.resolve(ROOT, "..", "halo-migration", "firefly", "posts");
const SRC_PAGES = path.resolve(ROOT, "..", "halo-migration", "firefly", "pages");
const POSTS_LIST = path.resolve(
  ROOT,
  "..",
  "halo-migration",
  "extracted",
  "01_posts_list.txt",
);
const ATTACH = path.resolve(ROOT, "..", "halo-migration", "attachments");
const ATTACH_EXTRA = path.resolve(
  ROOT,
  "..",
  "halo-migration",
  "attachments-extra",
);
const PUBLIC_FAVICON_DIR = path.join(ROOT, "public", "favicon");

/* 资源接线（封面/favicon/头像/友链 logo）—— 站点相对路径，均可由站点 API 直接服务 */
const FAVICON_PUBLIC = "/favicon/site-192.png"; // → basic.faviconUrl（FaviconLinks 解析顺序第一级）
const AVATAR_A_URL = "/api/covers/site/avatar-yangshu.webp"; // → profile.avatar（站主·卡通猫）
const AVATAR_B_URL = "/api/covers/friends/sure-avatar.png"; // → 4 条友链统一 logo（白楼蓝天）
// earlyoom 篇封面：01_posts_list L69 /upload/OpenClaw图… → attachments/upload/OpenClaw图标.svg
const COVER_SLUG_PREFIX = "zai-1gb";
const OUT = path.join(HERE, "out");
const OUT_POSTS = path.join(OUT, "posts");
const OUT_SQL = path.join(OUT, "sql");

const D1_UUID = "0a45a6b7-ab5e-4192-8c5b-92f055e06b97";
const R2_BUCKET = "firedre-blog";

// 与 cf.ps1/cf.cmd 相同的调用路径：node <npm-global>/node_modules/cf/bin/cf
const CF_BIN = "C:\\Program Files\\nodejs\\node_modules\\cf\\bin\\cf";
const NODE_EXE = "C:\\Program Files\\nodejs\\node.exe";

function cf(args, { allowFail = false } = {}) {
  const res = execFileSync(NODE_EXE, [CF_BIN, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (!allowFail && res === null) throw new Error(`cf 失败: ${args.join(" ")}`);
  return res;
}

/* ---------------- 复刻 Firedre 工具函数 ---------------- */

// server/utils/frontmatter.ts FRONTMATTER_RE
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseScalar(value) {
  const unquoted = unquote(value);
  if (unquoted === "true") return true;
  if (unquoted === "false") return false;
  if (/^-?\d+$/.test(unquoted)) return Number(unquoted);
  if (unquoted.startsWith("[") && unquoted.endsWith("]")) {
    const inner = unquoted.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(",")
      .map((item) => parseScalar(item.trim()))
      .filter((item) => item !== "");
  }
  return unquoted;
}

// server/posts/frontmatter.ts parseSimpleYaml（用于回读校验双源一致）
function parseSimpleYaml(yaml) {
  const result = {};
  let currentKey = null;
  let listItems = null;
  function flushList() {
    if (currentKey && listItems) result[currentKey] = listItems;
    listItems = null;
  }
  for (const rawLine of yaml.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const listMatch = line.match(/^\s*-\s+(.+)$/);
    if (listMatch && listItems) {
      listItems.push(unquote(listMatch[1].trim()));
      continue;
    }
    flushList();
    const kvMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kvMatch) continue;
    const key = kvMatch[1];
    const value = kvMatch[2].trim();
    currentKey = key;
    if (!value) {
      listItems = [];
      continue;
    }
    result[key] = parseScalar(value);
  }
  flushList();
  return result;
}

function splitMarkdown(source) {
  const match = source.match(FRONTMATTER_RE);
  if (!match) return { frontmatter: {}, content: source };
  return { frontmatter: parseSimpleYaml(match[1]), content: match[2] };
}

// server/posts/frontmatter.ts serializeFrontmatter
function serializeFrontmatter(fm, content) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fm)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${item}`);
      continue;
    }
    if (typeof value === "string" && /[:#]/.test(value))
      lines.push(`${key}: "${value.replace(/"/g, '\\"')}"`);
    else lines.push(`${key}: ${value}`);
  }
  lines.push("---", "");
  return `${lines.join("\n")}${content}`;
}

// server/posts/markdown.ts stripMarkdown
function stripMarkdown(content) {
  return content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]+`/g, " ")
    .replace(/![[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/[#>*_~-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// server/posts/render.ts countTextWords
function countTextWords(text) {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const cjk =
    trimmed.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g)?.length ?? 0;
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  return cjk + words;
}

/* ---------------- 工具 ---------------- */

function sqlStr(v) {
  if (v === null || v === undefined) return "NULL";
  return `'${String(v).replace(/'/g, "''")}'`;
}

function readPostSource(file) {
  const raw = fs.readFileSync(path.join(SRC_POSTS, file), "utf8");
  const m = raw.match(FRONTMATTER_RE);
  if (!m) throw new Error(`缺少 frontmatter: ${file}`);
  const fm = parseSimpleYaml(m[1]);
  return { fm, content: m[2] };
}

/**
 * 从 extracted/01_posts_list.txt 解析真实发布日期。
 * 第一区块（slug=post-N，deleted=True）= 删除态旧版本，带真实发布日期；
 * 活文章（N.-中文标题，deleted=False）日期已被迁移抹成 07-26，按标题
 * （大小写不敏感）回填。同日期多篇按删除态区块在文件中的出现顺序
 * 依次 +1 分钟，保证 date DESC 排序完全稳定。
 * 返回 Map<titleLower, 'YYYY-MM-DD HH:MM:00'>。
 */
function parseRealDates() {
  const text = fs.readFileSync(POSTS_LIST, "utf8");
  const lines = text.split(/\r?\n/);
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\d{4}-\d{2}-\d{2}) \| (.*?) \| (.*?) \|/);
    if (!m) continue;
    const next = lines[i + 1] ?? "";
    const dm = next.match(/deleted=(True|False)/);
    if (!dm) continue;
    entries.push({
      date: m[1],
      title: m[2].trim(),
      slug: m[3].trim(),
      deleted: dm[1] === "True",
    });
  }
  const deletedPosts = entries.filter(
    (e) => e.deleted && /^post-\d+$/.test(e.slug),
  );
  const map = new Map();
  const groupSeen = new Map();
  for (const e of deletedPosts) {
    const n = groupSeen.get(e.date) ?? 0;
    groupSeen.set(e.date, n + 1);
    const key = e.title.toLowerCase();
    if (map.has(key)) throw new Error(`01_posts_list 标题重复: ${e.title}`);
    map.set(key, `${e.date} 00:${String(n).padStart(2, "0")}:00`);
  }
  if (map.size !== 15)
    throw new Error(`01_posts_list 删除态 post-N 应为 15 篇，实际 ${map.size}`);
  return map;
}

/* ---------------- build ---------------- */

function build() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT_POSTS, { recursive: true });
  fs.mkdirSync(OUT_SQL, { recursive: true });

  const realDates = parseRealDates(); // 15 篇真实发布日期（01_posts_list.txt 复核）

  const files = fs.readdirSync(SRC_POSTS).filter((f) => f.endsWith(".md"));
  // 排序：1.-… → 15.-… → 拼音文件名（与 Halo 时间序无冲突，date 决定排序）
  files.sort((a, b) =>
    a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }),
  );

  const posts = [];
  for (const file of files) {
    const { fm, content } = readPostSource(file);

    const title = String(fm.title || "").trim();
    if (!title) throw new Error(`${file}: 无 title`);
    const slug = title; // 任务规定：slug = 中文标题
    // slug 卫生检查（H-6：避免 %；路径危险字符）
    if (fm.title !== slug) throw new Error(`${file}: title 首尾空白`);
    if (/%/.test(slug)) throw new Error(`${file}: slug 含字面 %`);
    if (/[\\/]|^\/|\/$|\/\/|\.\./.test(slug))
      throw new Error(`${file}: slug 含路径危险字符`);
    if (title.includes('"'))
      throw new Error(`${file}: title 含双引号（YAML 序列化不安全）`);

    // 日期：命中 01_posts_list 真实日期映射 → 用真实日期（同日多篇 +1 分钟）；
    // 未命中 = 两篇拼音 slug 文章（08-17 / 09-11），保持源 published 不动
    const mappedDate = realDates.get(title.toLowerCase());
    const date = mappedDate ?? `${String(fm.published || fm.date || "")} 00:00:00`;
    if (!/^\d{4}-\d{2}-\d{2} 00:\d{2}:00$/.test(date))
      throw new Error(`${file}: 日期格式异常 → ${date}`);
    if (!mappedDate && !/^2026-0[89]-\d{2} /.test(date))
      throw new Error(`${file}: 未命中真实日期映射且非已知两篇拼音文 → ${date}`);

    const description = String(fm.description || fm.excerpt || "");
    if (description.includes('"'))
      throw new Error(`${file}: description 含双引号（YAML 序列化不安全）`);

    const tags = Array.isArray(fm.tags)
      ? fm.tags.map(String).filter(Boolean)
      : fm.tags
        ? [String(fm.tags)]
        : [];
    const categories = ["默认分类"]; // 任务规定

    // 文章封面：earlyoom 篇 → R2 covers/<slug>/<file>；cover 列与 fm.image 存
    // 站点相对引用 /api/covers/<slug>/<file>（src/pages/api/covers/[...path].ts L18 键规则；
    // 列表取 image = item.cover ?? fm.image，post-types.ts L100）
    const coverFile = "OpenClaw图标.svg";
    const cover = file.startsWith(COVER_SLUG_PREFIX)
      ? `/api/covers/${slug}/${coverFile}`
      : null;

    // Firedre 形态 frontmatter（与 D1 列语义一致；fm_json = 本对象 JSON）
    const outFm = {
      title,
      slug,
      published: date,
      categories,
      tags,
      description,
      ...(cover ? { image: cover } : {}),
      draft: false, // 本批 17 篇全为已发布 → published=1
      pinned: false,
      lang: String(fm.lang || "zh-CN"),
      author: "杨树", // H-7：author 无 D1 列，fm_json 与 R2 双写
    };

    const source = serializeFrontmatter(outFm, content);

    // 双源一致回读校验：R2 md frontmatter 解析结果 === fm_json 来源对象
    const reparsed = splitMarkdown(source).frontmatter;
    const a = JSON.stringify(outFm);
    const b = JSON.stringify(reparsed);
    if (a !== b)
      throw new Error(
        `${file}: frontmatter 序列化往返不一致\nA=${a}\nB=${b}`,
      );

    const plain = stripMarkdown(splitMarkdown(source).content);
    const words = countTextWords(plain);
    const minutes = Math.max(1, Math.round(words / 200));

    const mdPath = path.join(OUT_POSTS, `${slug}.md`);
    fs.writeFileSync(mdPath, source, "utf8");

    posts.push({
      slug,
      title,
      excerpt: description,
      description,
      date,
      updated: null,
      categories,
      tags,
      cover,
      published: 1,
      password: "",
      fm: outFm,
      words,
      minutes,
      r2Key: `posts/${slug}.md`,
      pin_order: 0,
      plain,
      outFile: mdPath,
      srcFile: file,
      dateSource: mappedDate ? "01_posts_list" : "firefly-fm",
    });
  }

  if (posts.length !== 17)
    throw new Error(`文章数应为 17，实际 ${posts.length}`);
  const mappedCount = posts.filter((p) => p.dateSource === "01_posts_list").length;
  if (mappedCount !== 15)
    throw new Error(`真实日期映射应命中 15 篇，实际 ${mappedCount}`);
  const coverCount = posts.filter((p) => p.cover).length;
  if (coverCount !== 1)
    throw new Error(`封面文章应为 1 篇（earlyoom），实际 ${coverCount}`);

  // favicon：单文件放入 public/favicon/（FaviconLinks←settings.faviconUrl 引用）
  fs.mkdirSync(PUBLIC_FAVICON_DIR, { recursive: true });
  fs.copyFileSync(
    path.join(ATTACH_EXTRA, "favicon.png"),
    path.join(PUBLIC_FAVICON_DIR, "site-192.png"),
  );
  console.log(`[build] favicon → ${path.join(PUBLIC_FAVICON_DIR, "site-192.png")}`);

  // 打印日期清单（报告/复核用）
  console.log("[build] 日期清单（date DESC）：");
  for (const p of [...posts].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))) {
    console.log(`  ${p.date}  [${p.dateSource}]  ${p.slug}`);
  }

  const q = (s) => s.replace(/'/g, "''");
  const batches = { posts: [], taxonomy: [], fts: [], misc: [] };

  // 3. posts INSERT（REPORT-DATA-MODEL A 模板，幂等）
  for (const p of posts) {
    const fmJson = JSON.stringify(p.fm);
    const categories = JSON.stringify(p.categories);
    const tags = p.tags.length ? JSON.stringify(p.tags) : null;
    batches.posts.push({
      sql: `INSERT INTO posts (slug,title,excerpt,description,date,updated,categories,tags,cover,
  published,password,fm_json,words,minutes,r2_key,pin_order,created_at,updated_at)
VALUES (${sqlStr(p.slug)},${sqlStr(p.title)},${sqlStr(p.excerpt)},${sqlStr(p.description)},${sqlStr(p.date)},NULL,
  ${sqlStr(categories)},${tags === null ? "NULL" : sqlStr(tags)},${sqlStr(p.cover)},1,'',
  ${sqlStr(fmJson)},${p.words},${p.minutes},${sqlStr(p.r2Key)},0,datetime('now'),datetime('now'))
ON CONFLICT(slug) DO UPDATE SET title=excluded.title,excerpt=excluded.excerpt,description=excluded.description,
  date=excluded.date,updated=excluded.updated,categories=excluded.categories,tags=excluded.tags,
  cover=excluded.cover,published=excluded.published,password=excluded.password,fm_json=excluded.fm_json,
  words=excluded.words,minutes=excluded.minutes,r2_key=excluded.r2_key,pin_order=excluded.pin_order,
  updated_at=datetime('now')`,
    });
  }

  // 4. post_taxonomy（每篇先 DELETE 再 1×category + N×tag，C 模板）
  for (const p of posts) {
    const rows = [
      `(${sqlStr(p.slug)},'category','默认分类')`,
      ...p.tags.map((t) => `(${sqlStr(p.slug)},'tag',${sqlStr(t)})`),
    ];
    batches.taxonomy.push({
      sql: `DELETE FROM post_taxonomy WHERE post_slug=${sqlStr(p.slug)}`,
    });
    batches.taxonomy.push({
      sql: `INSERT INTO post_taxonomy (post_slug,type,value) VALUES ${rows.join(",")}`,
    });
  }

  // 5. posts_fts 同步（B 模板，content = strip 正文）
  for (const p of posts) {
    batches.fts.push({
      sql: `DELETE FROM posts_fts WHERE slug=${sqlStr(p.slug)}`,
    });
    batches.fts.push({
      sql: `INSERT INTO posts_fts (slug,title,excerpt,content) VALUES (${sqlStr(p.slug)},${sqlStr(p.title)},${sqlStr(p.excerpt)},${sqlStr(p.plain)})`,
    });
  }

  // 6. friends：先 DELETE 基线 3 条种子，再插 4 条真实友链（D 模板）。
  // imgurl 统一为头像 B（白楼蓝天）的站点相对地址：原站下线后外部 URL 会挂；
  // 后台校验 imgurl 非空（friends/service.ts L24）且前台无默认头像回退（friends.astro L146），
  // 故 4 条全部填图，不留空。
  const friends = [
    {
      id: 1,
      title: "Sure的小站",
      imgurl: AVATAR_B_URL,
      desc: "一个博客",
      siteurl: "https://sure-block.cc.cd/",
      weight: 2,
    },
    {
      id: 2,
      title: "Sure的音乐小站",
      imgurl: AVATAR_B_URL,
      desc: "",
      siteurl: "https://music.sure-block.cc.cd/",
      weight: 4,
    },
    {
      id: 3,
      title: "Sure的域名邮箱小站",
      imgurl: AVATAR_B_URL,
      desc: "一个使用cloudmail开源项目搭建的域名\n邮箱",
      siteurl: "https://mail.suremail.cc.cd/",
      weight: 5,
    },
    {
      id: 4,
      title: "Sure的小说网站",
      imgurl: AVATAR_B_URL,
      desc: "一个开源的部署在cloudflare的小说网站",
      siteurl: "https://novel.sure-block.cc.cd/",
      weight: 3,
    },
  ];
  batches.misc.push({ sql: "DELETE FROM friends" });
  batches.misc.push({
    sql: `INSERT INTO friends (id,title,imgurl,desc,siteurl,tags,weight,enabled,created_at,updated_at) VALUES\n${friends
      .map(
        (f) =>
          ` (${f.id},${sqlStr(f.title)},${sqlStr(f.imgurl)},${sqlStr(f.desc)},${sqlStr(f.siteurl)},'',${f.weight},1,datetime('now'),datetime('now'))`,
      )
      .join(",")}`,
  });

  // 7. site_settings：basic 用 json_patch 增量写（勿整行覆盖）；nav 直接写 6 项；
  //    profile 组写站主头像 A（adminSettingsSchema/site.ts L163 avatar 字段）
  const basicPatch = JSON.stringify({
    title: "杨树",
    subtitle: "全网最不正经的博客",
    faviconUrl: FAVICON_PUBLIC,
  });
  batches.misc.push({
    sql: `INSERT INTO site_settings (key,value,updated_at)
VALUES ('basic', json(${sqlStr(basicPatch)}), datetime('now'))
ON CONFLICT(key) DO UPDATE SET value=json_patch(value,${sqlStr(basicPatch)}), updated_at=datetime('now')`,
  });

  const profilePatch = JSON.stringify({ avatar: AVATAR_A_URL });
  batches.misc.push({
    sql: `INSERT INTO site_settings (key,value,updated_at)
VALUES ('profile', json(${sqlStr(profilePatch)}), datetime('now'))
ON CONFLICT(key) DO UPDATE SET value=json_patch(value,${sqlStr(profilePatch)}), updated_at=datetime('now')`,
  });

  const navItems = [
    { name: "首页", url: "/", icon: "material-symbols:home" },
    { name: "文章", url: "/posts/", icon: "material-symbols:article" },
    { name: "关于", url: "/about/", icon: "material-symbols:info" },
    { name: "友链", url: "/friends/", icon: "material-symbols:link-2-rounded" },
    { name: "隐私政策", url: "/privacy/", icon: "material-symbols:shield" },
    { name: "用户协议", url: "/terms/", icon: "material-symbols:gavel" },
  ];
  const navJson = JSON.stringify({ navItems });
  batches.misc.push({
    sql: `INSERT INTO site_settings (key,value,updated_at)
VALUES ('nav', json(${sqlStr(navJson)}), datetime('now'))
ON CONFLICT(key) DO UPDATE SET value=json_patch(value,excluded.value), updated_at=datetime('now')`,
  });

  // 8. bump 版本（H-5）
  batches.misc.push({
    sql: `INSERT INTO site_settings (key,value,updated_at)
VALUES('__firedre_settings_version','1',datetime('now'))
ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1, updated_at=datetime('now')`,
  });

  // 9. 幂等清理兜底：空表 auto-seed 的 'firedre' 演示文章（连删 FTS/taxonomy）
  batches.misc.push({ sql: "DELETE FROM posts_fts WHERE slug='firedre'" });
  batches.misc.push({
    sql: "DELETE FROM post_taxonomy WHERE post_slug='firedre'",
  });
  batches.misc.push({ sql: "DELETE FROM posts WHERE slug='firedre'" });

  for (const [name, arr] of Object.entries(batches)) {
    if (arr.length > 100)
      throw new Error(`batch ${name} 超过 100 条语句（D1 限制）`);
    fs.writeFileSync(
      path.join(OUT_SQL, `${name}.json`),
      JSON.stringify(arr, null, 1),
      "utf8",
    );
  }

  // R2 上传清单（17 篇 + 三页面 + 3 个资源对象）
  const coverPost = posts.find((p) => p.cover);
  const r2 = [
    ...posts.map((p) => ({ key: p.r2Key, file: p.outFile, kind: "post" })),
    {
      key: "about/index.md",
      file: path.join(SRC_PAGES, "about.md"),
      kind: "about",
    },
    {
      key: "spec/privacy.md",
      file: path.join(SRC_PAGES, "privacy.md"),
      kind: "spec",
    },
    {
      key: "spec/terms.md",
      file: path.join(SRC_PAGES, "terms.md"),
      kind: "spec",
    },
    // 资源接线
    {
      key: `covers/${coverPost.slug}/OpenClaw图标.svg`,
      file: path.join(ATTACH, "upload", "OpenClaw图标.svg"),
      kind: "cover",
      contentType: "image/svg+xml",
    },
    {
      key: "covers/site/avatar-yangshu.webp",
      file: path.join(ATTACH, "upload", "头像.webp"),
      kind: "avatar-a",
      contentType: "image/webp",
    },
    {
      key: "covers/friends/sure-avatar.png",
      file: path.join(ATTACH, "upload", "bbfa5cd7-6075-46aa-b5f3-41177ca909bc.png"),
      kind: "avatar-b",
      contentType: "image/png",
    },
  ];
  for (const item of r2)
    if (!fs.existsSync(item.file))
      throw new Error(`R2 源文件缺失: ${item.file}`);

  const taxonomyRows = posts.reduce(
    (n, p) => n + 1 + p.tags.length,
    0,
  );
  const manifest = {
    generatedAt: new Date().toISOString(),
    posts: posts.map((p) => ({
      slug: p.slug,
      title: p.title,
      date: p.date,
      tags: p.tags,
      words: p.words,
      minutes: p.minutes,
      r2_key: p.r2Key,
      outFile: p.outFile,
    })),
    r2,
    counts: {
      posts: posts.length,
      taxonomyRows,
      ftsRows: posts.length,
      r2Objects: r2.length,
    },
    batchStatements: Object.fromEntries(
      Object.entries(batches).map(([k, v]) => [k, v.length]),
    ),
  };
  fs.writeFileSync(
    path.join(OUT, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );

  console.log("[build] 完成");
  console.log(
    JSON.stringify(
      { counts: manifest.counts, batchStatements: manifest.batchStatements },
      null,
      2,
    ),
  );
}

/* ---------------- r2 ---------------- */

function r2Upload() {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(OUT, "manifest.json"), "utf8"),
  );
  let ok = 0;
  for (const item of manifest.r2) {
    cf([
      "r2",
      "objects",
      "put",
      item.key,
      "--bucket-name",
      R2_BUCKET,
      "--file",
      item.file,
      "--content-type",
      item.contentType ?? "text/markdown",
    ]);
    ok++;
    console.log(`[r2] put ${item.key}`);
  }
  // 兜底：若存在 auto-seed 的 posts/firedre.md 则删除（空桶预期不存在）
  try {
    const listed = cf([
      "r2",
      "objects",
      "list",
      "--bucket-name",
      R2_BUCKET,
      "--prefix",
      "posts/firedre.md",
    ]);
    const parsed = JSON.parse(listed);
    const objs = parsed.result?.objects ?? parsed.objects ?? [];
    if (objs.some((o) => o.key === "posts/firedre.md" || o.name === "posts/firedre.md")) {
      cf([
        "r2",
        "objects",
        "delete",
        "posts/firedre.md",
        "--bucket-name",
        R2_BUCKET,
      ]);
      console.log("[r2] 已删除演示对象 posts/firedre.md");
    } else {
      console.log("[r2] posts/firedre.md 不存在，无需清理");
    }
  } catch (e) {
    console.log(`[r2] firedre.md 检查跳过: ${e.message}`);
  }
  console.log(`[r2] 上传完成 ${ok}/${manifest.r2.length}`);
}

/* ---------------- d1 ---------------- */

function d1Run() {
  const order = [
    "posts.json",
    "taxonomy.json",
    "fts.json",
    "misc.json",
  ];
  for (const file of order) {
    const p = path.join(OUT_SQL, file);
    const n = JSON.parse(fs.readFileSync(p, "utf8")).length;
    cf(["d1", "query", D1_UUID, "--batch", `@${p}`]);
    console.log(`[d1] ${file} 执行完成（${n} 条语句）`);
  }
}

/* ---------------- verify ---------------- */

const VERIFY_QUERIES = [
  ["G12-1 posts 总数/发布数", "SELECT COUNT(*) AS posts, SUM(published) AS published FROM posts"],
  ["G12-2 posts_fts 行数", "SELECT COUNT(*) AS fts FROM posts_fts"],
  ["G12-3 post_taxonomy 行数/分类/标签", "SELECT COUNT(*) AS rows, SUM(type='category') AS cats, SUM(type='tag') AS tags FROM post_taxonomy"],
  ["G12-3b taxonomy 值分布", "SELECT type, value, COUNT(*) AS n FROM post_taxonomy GROUP BY type, value ORDER BY type, value"],
  ["G12-4 friends 4 条", "SELECT id,title,imgurl,desc,siteurl,tags,weight,enabled FROM friends ORDER BY id"],
  ["G12-5 site_settings 行", "SELECT key, value, updated_at FROM site_settings WHERE key IN ('basic','profile','nav','__firedre_settings_version') ORDER BY key"],
  ["G12-6 posts 列抽样", "SELECT slug, date, categories, tags, published, words, minutes, r2_key FROM posts ORDER BY date DESC, slug LIMIT 20"],
  ["G12-7 firedre 演示文章清理", "SELECT (SELECT COUNT(*) FROM posts WHERE slug='firedre') AS posts, (SELECT COUNT(*) FROM posts_fts WHERE slug='firedre') AS fts, (SELECT COUNT(*) FROM post_taxonomy WHERE post_slug='firedre') AS tax"],
  ["G12-8 FTS 内容抽查（LIKE 三列，不依赖分词器）", "SELECT f.slug FROM posts_fts f JOIN posts p ON p.slug=f.slug WHERE (f.content LIKE '%湿巾%' OR f.excerpt LIKE '%湿巾%' OR f.title LIKE '%湿巾%') AND p.published=1"],
  ["G12-8b FTS trigram MATCH 抽查（3 字词）", "SELECT f.slug FROM posts_fts f JOIN posts p ON p.slug=f.slug WHERE posts_fts MATCH '便利店' AND p.published=1"],
  ["G12-9 文章封面接线", "SELECT slug, cover, json_extract(fm_json,'$.image') AS fm_image FROM posts WHERE cover IS NOT NULL"],
];

function verify() {
  const out = {};
  for (const [label, sql] of VERIFY_QUERIES) {
    const res = cf(["d1", "query", D1_UUID, "--sql", sql]);
    console.log(`\n===== ${label} =====`);
    console.log(res.trim());
    out[label] = JSON.parse(res);
  }
  // R2 对象列表
  const listed = cf([
    "r2",
    "objects",
    "list",
    "--bucket-name",
    R2_BUCKET,
    "--per-page",
    "1000",
  ]);
  console.log("\n===== R2 对象清单 =====");
  console.log(listed.trim());
  out["R2 objects"] = JSON.parse(listed);
  fs.writeFileSync(
    path.join(OUT, "verify-result.json"),
    JSON.stringify(out, null, 2),
    "utf8",
  );
  console.log(`\n[verify] 结果已写 ${path.join(OUT, "verify-result.json")}`);
}

/* ---------------- main ---------------- */

const stage = process.argv[2] || "all";
if (stage === "build") build();
else if (stage === "r2") r2Upload();
else if (stage === "d1") d1Run();
else if (stage === "verify") verify();
else if (stage === "all") {
  build();
  r2Upload();
  d1Run();
  verify();
} else {
  console.error(`未知阶段: ${stage}（build|r2|d1|verify|all）`);
  process.exit(1);
}
