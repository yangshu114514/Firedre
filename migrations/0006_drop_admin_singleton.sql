-- 删除 admin_users 的单例唯一索引。
--
-- 0001 里 `CREATE UNIQUE INDEX idx_admin_users_singleton ON admin_users((1))`
-- 强制全表只允许一行。实际代码全部按 username 定位（getAdminUserByUsername /
-- adminSession），不依赖单行假设；单行反而把「站长写库建账号」这条唯一路径
-- 卡死成一次性操作，第二个管理员永远写不进去。
-- 与 users 体系（可多管理员，role='admin'）对齐，恢复多管理员能力。

DROP INDEX IF EXISTS idx_admin_users_singleton;
