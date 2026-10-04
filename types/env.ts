export interface CloudflareEnv {
	DB: D1Database;
	BUCKET: R2Bucket;
	WEBDAV_PASSWORD?: string;

	SESSION_SECRET?: string;
	/** 用户会话 HMAC 密钥（复用为媒体门票签名密钥，server/media/ticket.ts） */
	USER_SESSION_SECRET?: string;
}
