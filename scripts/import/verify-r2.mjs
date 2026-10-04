// 抽样/全量比对 R2 远端对象与本地文件字节一致性
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CF_BIN = "C:\\Program Files\\nodejs\\node_modules\\cf\\bin\\cf";
const NODE_EXE = "C:\\Program Files\\nodejs\\node.exe";
const manifest = JSON.parse(
  fs.readFileSync(path.join(HERE, "out", "manifest.json"), "utf8"),
);

let same = 0;
let diff = 0;
for (const item of manifest.r2) {
  // 文本（md）用 --text UTF-8 解码比较；图片等二进制资源取原始字节比较
  const isText = (item.contentType ?? "text/markdown").startsWith("text/");
  const args = [
    "r2",
    "objects",
    "get",
    item.key,
    "--bucket-name",
    "firedre-blog",
    ...(isText ? ["--text"] : []),
  ];
  const remote = execFileSync(NODE_EXE, [CF_BIN, ...args], {
    ...(isText ? { encoding: "utf8" } : {}),
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  const local = isText
    ? fs.readFileSync(item.file, "utf8")
    : fs.readFileSync(item.file);
  const match = isText ? remote === local : Buffer.compare(remote, local) === 0;
  if (match) {
    same++;
    console.log(`MATCH  ${item.key}`);
  } else {
    diff++;
    console.log(
      `DIFF   ${item.key} remoteLen=${remote.length} localLen=${local.length}`,
    );
  }
}
console.log(`\n合计 ${same} MATCH / ${diff} DIFF（共 ${manifest.r2.length}）`);
process.exit(diff ? 1 : 0);
