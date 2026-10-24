# Orbit Web Interface

Orbit 的 Next.js 前端，包含文献问答工作台与 Orbit+ 多智能体协作界面。

项目介绍、界面展示、系统设计及完整启动步骤见 [项目 README](../README.md)。

## 本地开发

在本目录执行：

```bash
npm ci
npm run dev
```

- Orbit：<http://localhost:3000>
- Orbit+：<http://localhost:3000/orbit-plus>
- 后端默认地址：`http://localhost:8000`

请先按照根目录 README 配置并启动后端。两个页面中的 `API_BASE` 需要与后端地址保持一致。

## 主要文件

| 文件 | 职责 |
| --- | --- |
| `app/page.tsx` | 文献管理、检索问答、引用展示 |
| `app/orbit-plus/page.tsx` | 模型与角色配置、独立对话状态、自动交互编排 |
| `app/components/` | 共享界面组件 |
| `app/globals.css` | 全局样式 |

## 开发命令

```bash
npm run lint   # 静态检查
npm run build  # 生产构建
npm run start  # 运行已构建的前端
```

当前 Orbit+ 对话状态保存在页面内存中，刷新会清空。模型凭据由后端读取，不应写入前端代码。
