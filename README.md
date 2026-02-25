<div align="center">
  <img src="build/icon.png" alt="FusionKit Logo" width="128" height="128" />
  <h1>FusionKit</h1>
  <p>一站式跨平台桌面工具集合</p>
  <p>
    <a href="https://github.com/QiuYeDx/FusionKit/releases/latest">
      <img src="https://img.shields.io/github/v/release/QiuYeDx/FusionKit?style=flat-square&color=blue" alt="Latest Release" />
    </a>
    <a href="https://github.com/QiuYeDx/FusionKit/blob/main/LICENSE">
      <img src="https://img.shields.io/github/license/QiuYeDx/FusionKit?style=flat-square" alt="License" />
    </a>
    <a href="https://github.com/QiuYeDx/FusionKit/releases">
      <img src="https://img.shields.io/github/downloads/QiuYeDx/FusionKit/total?style=flat-square&color=green" alt="Downloads" />
    </a>
    <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey?style=flat-square" alt="Platform" />
  </p>
</div>

---

## 简介

**FusionKit** 是一款基于 Electron 的跨平台桌面工具集合应用，旨在将多种实用工具整合在一个优雅的界面中。目前已提供字幕处理相关工具，更多工具正在持续开发中。

## 功能特性

### 字幕翻译

利用 AI 大模型实现高质量字幕翻译，支持多种模型和灵活配置。

- 支持 **LRC / SRT / VTT** 格式字幕文件
- 支持 **DeepSeek / OpenAI** 及自定义兼容 API
- 日文到中文翻译，保留原文对照
- 批量任务并发处理（最高 5 路并发）
- 可配置分片模式（普通 / 敏感 / 自定义）
- 实时进度显示与 Token 用量预估

### 字幕格式转换

在主流字幕格式之间自由转换。

- 支持 **SRT / VTT / LRC** 格式互转
- 自定义输出路径与重名处理策略
- 可选去除媒体类型后缀

### 字幕语言提取

从双语字幕中提取指定语言的内容。

- 支持从双语字幕中提取中文或日文
- 自定义输出路径与重名处理策略

### 更多工具（开发中）

- 批量文件重命名
- 付费音乐解密转换

## 其他特性

- 🌓 深色 / 浅色 / 跟随系统主题
- 🌐 多语言支持（简体中文 / English / 日本語）
- 🔄 应用内检查更新与自动更新
- 🌍 网络代理配置（无代理 / 系统代理 / 自定义代理）
- 🖥 跨平台支持（macOS / Windows）

## 技术栈

| 分类 | 技术 |
| --- | --- |
| 框架 | Electron 33 + React 19 |
| 语言 | TypeScript |
| 构建工具 | Vite 5 |
| 样式 | Tailwind CSS 4 |
| UI 组件 | shadcn/ui (Radix UI) |
| 状态管理 | Zustand |
| 国际化 | i18next |
| 动画 | Motion |
| 测试 | Vitest + Playwright |
| 包管理器 | pnpm |

## 快速开始

### 环境要求

- **Node.js** >= 18.0.0
- **pnpm**（推荐使用 [corepack](https://nodejs.org/api/corepack.html) 启用）

### 安装与开发

```bash
# 克隆仓库
git clone https://github.com/QiuYeDx/FusionKit.git
cd FusionKit

# 安装依赖
pnpm install

# 启动开发服务器
pnpm dev
```

### 构建发布

```bash
pnpm build
```

构建产物将输出到 `release` 目录。

## 项目结构

```
FusionKit/
├── electron/                  # Electron 主进程
│   ├── main/                  # 主进程核心逻辑
│   │   ├── index.ts           # 窗口管理与 IPC 注册
│   │   ├── translation/       # AI 翻译引擎
│   │   ├── conversion/        # 字幕格式转换
│   │   ├── extraction/        # 字幕语言提取
│   │   ├── proxy.ts           # 代理配置
│   │   ├── power.ts           # 防休眠管理
│   │   └── update.ts          # 自动更新
│   └── preload/               # 预加载脚本
├── src/                       # 渲染进程（前端）
│   ├── pages/                 # 页面组件
│   ├── components/            # UI 组件库
│   │   ├── ui/                # shadcn/ui 基础组件
│   │   └── qiuye-ui/          # 自定义组件
│   ├── store/                 # Zustand 状态管理
│   ├── locales/               # i18n 多语言资源
│   ├── constants/             # 常量定义
│   ├── types/                 # TypeScript 类型
│   └── utils/                 # 工具函数
├── build/                     # 应用图标资源
├── public/                    # 静态资源
└── test/                      # E2E 测试
```

## 配置说明

### AI 模型配置

在应用设置中配置 AI 翻译所需的模型参数：

- **API Endpoint** — 模型 API 地址
- **API Key** — 访问密钥
- **Model** — 模型名称
- **Token 价格** — 用于费用预估

内置 DeepSeek 和 OpenAI 预设，也支持任意 OpenAI 兼容 API。

### 翻译分片模式

| 模式 | 分片大小 | 适用场景 |
| --- | --- | --- |
| 普通模式 | ~3000 字符 | 大多数字幕文件 |
| 敏感模式 | ~100 字符 | 特殊内容，需更精细控制 |
| 自定义模式 | 自定义 | 按需调整 |

## 贡献指南

欢迎任何形式的贡献！

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/your-feature`)
3. 提交更改 (`git commit -m 'feat: add your feature'`)
4. 推送到分支 (`git push origin feature/your-feature`)
5. 发起 Pull Request

## 许可证

本项目采用 [PolyForm Noncommercial License 1.0.0](LICENSE) 发布，仅允许非商业使用，禁止用于任何商业目的。

## 相关链接

- **项目主页**：[github.com/QiuYeDx/FusionKit](https://github.com/QiuYeDx/FusionKit)
- **问题反馈**：[Issues](https://github.com/QiuYeDx/FusionKit/issues)
- **版本发布**：[Releases](https://github.com/QiuYeDx/FusionKit/releases)
- **更新日志**：[CHANGELOG.md](CHANGELOG.md)
- **作者主页**：[qiuvision.com](https://qiuvision.com)
