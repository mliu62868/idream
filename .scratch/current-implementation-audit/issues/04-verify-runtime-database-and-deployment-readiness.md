# 核验数据库、队列与部署就绪态

Type: task

## Question

使用只读检查，当前可用环境中的 Main／Chat PostgreSQL schema 与 manual SQL invariants、Redis／BullMQ、Blob／CHAT_FS_ROOT、PM2 进程、standalone build fingerprint、Gen／Voice／Chat provider 预检、launch readiness 与 durable backlog 处于什么状态？明确区分仓库 migration 存在、开发库已应用、目标环境已应用和生产 cutover 已完成；不得执行迁移、写业务数据或把 mock／fallback 当成真实 provider 证据。
