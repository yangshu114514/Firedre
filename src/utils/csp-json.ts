/**
 * 把任意值序列化成可安全嵌入 `<script type="application/json">` 的字符串。
 *
 * 为什么需要它：
 * CSP 的 `script-src` 白名单用的是「内联脚本内容的 sha256」，这就要求脚本内容
 * 与构建期哈希逐字节一致。任何来自数据库的可变数据（站点设置、文章元数据）
 * 只要混进脚本体，内容一变哈希就失效，脚本会被浏览器静默拦掉。
 * 因此这类数据统一挪进 `<script type="application/json">` —— 它不执行，
 * 不受 `script-src` 管辖，内容怎么变都不影响 CSP。
 *
 * 为什么必须转义 `<`：`set:html` 是**原样注入**、不做 HTML 转义，
 * 数据里一旦出现 `</script>` 就会提前闭合标签并造成 HTML 注入。
 * 转义成 `\u003c` 后 JSON.parse 仍能得到原字符。
 */
export function jsonForScript(value: unknown): string {
	return JSON.stringify(value ?? null).replace(/</g, "\\u003c");
}

/**
 * 读取紧邻在前面的 JSON 配置块。
 *
 * 用法（必须放在 `is:inline` 的经典脚本里，此时 document.currentScript 有效）：
 *   const cfg = readJsonConfig();
 *
 * 之所以用 previousElementSibling 而不是 getElementById：
 * 同一组件可能在一页里渲染多次（如多个广告位），固定 id 会读到第一个实例的数据。
 */
export function jsonConfigScriptSource(): string {
	return "JSON.parse(document.currentScript.previousElementSibling.textContent)";
}
