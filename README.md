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

**FusionKit** 是一款基于 Electron 的跨平台桌面工具集合应用，旨在将多种实用工具整合在一个优雅的界面中。内置 AI 助手，可通过自然语言对话驱动字幕翻译、格式转换与语言提取等操作，同时也提供完整的手动工具界面。

## 功能特性

### FusionKit Assistant（AI 助手）

内置 AI 对话助手，通过自然语言即可完成字幕处理任务。

- 基于 **Vercel AI SDK** 的流式对话与工具调用循环
- 自动扫描目录、发现字幕文件并分发到对应工具队列
- 三种执行模式：**仅入队** / **确认后执行** / **自动执行**
- 会话导出与导入（JSON 格式）
- 实时 Token 用量统计与费用追踪

### 字幕翻译

利用 AI 大模型实现高质量字幕翻译，支持多种模型和灵活配置。

- 支持 **LRC / SRT** 格式字幕文件
- 支持 **9 种语言**：中文、日文、英文、韩文、法文、德文、西班牙文、俄文、葡萄牙文
- 支持 **DeepSeek / OpenAI** 及任意 OpenAI 兼容 API
- 双语对照或仅译文两种输出模式
- 分片并发翻译（最高 5 路并发）
- 可配置分片策略（普通 / 敏感 / 自定义）
- 实时进度显示与 Token 用量预估

### 字幕格式转换

在主流字幕格式之间自由转换。

- 支持 **SRT / VTT / LRC** 三种格式互转（6 条转换路径）
- 自定义输出路径与重名处理策略（覆盖 / 自动编号）
- 可选去除媒体类型后缀（如 `song.wav.srt` → `song.srt`）

### 字幕语言提取

从双语字幕中提取指定语言的内容。

- 支持从 **LRC / SRT** 双语字幕中提取中文或日文
- 基于假名、标点、虚词等多维度启发式语言识别
- 自定义输出路径与重名处理策略

### 更多工具（开发中）

- 批量文件重命名
- 付费音乐解密转换

## 其他特性

- 🌓 深色 / 浅色 / 跟随系统主题
- 🌐 多语言界面（简体中文 / English / 日本語）
- 🔄 应用内检查更新与自动更新
- 🌍 网络代理配置（无代理 / 系统代理 / 自定义代理）
- 💤 防休眠管理（翻译等长时任务运行期间自动阻止系统休眠）
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
| AI 集成 | Vercel AI SDK + OpenAI Compatible Provider |
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
│   │   ├── fs/                # 文件系统操作（扫描、读取、元数据）
│   │   ├── proxy.ts           # 代理配置
│   │   ├── power.ts           # 防休眠管理
│   │   └── update.ts          # 自动更新
│   └── preload/               # 预加载脚本（Context Bridge）
├── src/                       # 渲染进程（前端）
│   ├── agent/                 # AI 助手核心（orchestrator、工具定义、会话管理）
│   ├── pages/                 # 页面组件
│   │   ├── HomeAgent/         # AI 助手主页
│   │   ├── Tools/             # 字幕工具页（翻译 / 转换 / 提取）
│   │   ├── Setting/           # 设置页（通用 / 代理 / 模型）
│   │   └── About/             # 关于页
│   ├── components/            # UI 组件库
│   │   ├── ui/                # shadcn/ui 基础组件
│   │   └── qiuye-ui/          # 自定义组件
│   ├── store/                 # Zustand 状态管理
│   ├── locales/               # i18n 多语言资源
│   ├── constants/             # 常量定义
│   ├── types/                 # TypeScript 类型
│   └── utils/                 # 工具函数
├── docs/                      # 开发文档
├── build/                     # 应用图标资源
├── public/                    # 静态资源
└── test/                      # E2E 测试
```

## 配置说明

### AI 模型配置

在设置页面可分别配置**字幕翻译**和 **AI 助手**所用的模型参数：

- **API Endpoint** — OpenAI 兼容的 Chat Completions 端点
- **API Key** — 访问密钥
- **Model** — 模型名称
- **Token 价格** — 输入/输出单价（每百万 token），用于费用预估

内置 DeepSeek 和 OpenAI 预设，也支持任意 OpenAI 兼容 API。

### 翻译分片策略

翻译时会将字幕按 Token 上限拆分为多个分片，每个分片独立调用一次 LLM。

| 模式 | 分片上限 | 适用场景 |
| --- | --- | --- |
| 普通模式 | ~3000 tokens | 大多数字幕文件 |
| 敏感模式 | ~100 tokens | 特殊内容，需更精细控制 |
| 自定义模式 | 用户指定 | 按需调整 |

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
