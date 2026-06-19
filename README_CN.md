# 世界杯采集器 — 模拟与预测

这是一个为 2026 年世界杯设计的轻量级采集、学习与仿真项目，提供本地零依赖 HTTP 服务用于浏览赛事数据、赔率快照和模型学习结果。

主要特点
- 零依赖 HTTP 服务（Node.js 原生模块实现）同时提供 API 与前端静态页面。
- 后台定时任务：学习复盘与赔率刷新（可通过配置开启/关闭）。
- 数据落盘在 `data/` 目录，包含赔率历史、学习报表、快照等。

快速开始

要求：Node.js >= 20

安装依赖：本项目为零依赖，通常不需要 `npm install`，但保留一般步骤：

```bash
npm install
```

运行服务：

```bash
npm start
# 或
node src/server.js
```

常用脚本
- `npm run check` — 运行 `src/verify.js` 做项目检查
- `npm run learn` — 运行 `src/learn.js` 触发学习流程
- `npm run hourly` — 运行 `src/jobs/hourly-learning.js`（计划任务模拟）
- `npm run odds` — 运行 `src/jobs/odds-refresh.js`（刷新赔率）

主要 API（示例）
- `GET /api/health` — 健康检查
- `GET /api/overview` — 仪表盘数据（可用 `?refresh=1` 强制刷新，需管理员权限）
- `POST /api/refresh` — 触发全量刷新（仅 POST 且需管理员权限）
- `GET /api/learning` — 学习报告
- `GET /api/odds-history?eventId=...` — 指定比赛的赔率历史

安全与配置
- 管理接口需要基于 `src/api/security.js` 的 `refreshToken` 验证；请不要在公开仓库中提交真实凭证。
- `src/config.js` 定义端口、主机、数据路径与定时器间隔，可按需调整。

数据与敏感文件
- `data/` 目录可能包含大文件与历史快照，建议在公开仓库中使用 `.gitignore` 忽略敏感或大体积数据（如 `data/*.json` 或 `data/odds-archives/*`）。

许可证
- 本仓库使用 MIT 许可证（详见 `LICENSE`）。

贡献
- 欢迎通过 issue 或 PR 提交改进。在提交前请移除或脱敏任何私密凭证或大体量数据。
