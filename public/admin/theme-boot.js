/*
 * 后台主题引导脚本（同源静态文件，由 AdminHead.astro 在 <head> 内同步加载）。
 *
 * 为什么不做成内联脚本：线上 CSP 的 script-src 用「内联脚本 sha256 白名单」
 * （见 src/generated/csp-hashes.ts），而哈希扫描（scripts/collect-csp-hashes.mjs）
 * 的路由来自 sitemap + 公开页硬编码列表，**不覆盖 /admin/**：未登录访客访问
 * 后台会被 302 到 /login/，扫不到后台 HTML。本脚本的哈希因此从未进白名单，
 * 被浏览器静默拦掉（后台主题不跟随、首屏闪主题）。
 * 挪到同源静态文件后由 script-src 'self' 放行；它仍是 <head> 里的同步经典脚本
 * （Astro is:inline 不加工、不加 type="module"），绘制前执行，不会闪主题。
 *
 * 配置来源不变：仍读取紧邻在前面的
 * <script type="application/json" id="admin-theme-config"> 块（defaultMode/defaultHue）。
 */
(function () {
	var configScript =
		document.currentScript && document.currentScript.previousElementSibling;
	if (!configScript || configScript.tagName !== "SCRIPT") {
		configScript = document.getElementById("admin-theme-config");
	}
	if (!configScript) return;

	var parsed;
	try {
		parsed = JSON.parse(configScript.textContent);
	} catch (e) {
		return;
	}
	var defaultMode = parsed.defaultMode;
	var defaultHue = parsed.defaultHue;

	(function () {
		try {
			var DARK = "dark";
			var SYSTEM = "system";
			var theme = localStorage.getItem("theme") || defaultMode;
			var isDark =
				theme === SYSTEM
					? window.matchMedia("(prefers-color-scheme: dark)").matches
					: theme === DARK;
			document.documentElement.classList.toggle("dark", isDark);
			document.documentElement.setAttribute(
				"data-theme",
				isDark ? "one-dark-pro" : "one-light",
			);
			var hue = localStorage.getItem("hue") || defaultHue;
			document.documentElement.style.setProperty("--hue", hue);
		} catch (e) {}
	})();
})();
