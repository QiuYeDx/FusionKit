# FusionKit

FusionKit 是一个基于 Electron 的桌面工具集合应用，目前主要提供字幕翻译功能。

## 功能特点

### 字幕翻译
- 支持 LRC、SRT 格式字幕文件
- 日文到中文的翻译
- 保留原文对照显示
- 支持批量任务处理
- 可自定义分片模式
- 实时显示翻译进度

## 技术栈

- Electron
- React
- TypeScript
- Tailwind CSS
- Zustand (状态管理)
- i18next (国际化)

## 开发环境配置

1. 克隆仓库
```bash
git clone https://github.com/yourusername/FusionKit.git
cd FusionKit
```

2. 安装依赖
```bash
npm install
```

3. 启动开发服务器
```bash
npm run dev
```

## 构建

```bash
npm run build
```

构建后的应用将在 `release` 目录中生成。

## 项目结构

```
FusionKit/
├── electron/              # Electron 主进程代码
│   ├── main/             # 主进程核心逻辑
│   └── preload/          # 预加载脚本
├── src/                  # 渲染进程代码
│   ├── components/       # React 组件
│   ├── pages/           # 页面组件
│   ├── store/           # Zustand 状态管理
│   ├── locales/         # i18n 翻译文件
│   └── types/           # TypeScript 类型定义
└── public/              # 静态资源
```

## 配置说明

### 翻译模式
- 普通模式：适用于大多数字幕文件
- 敏感模式：更小的分片大小，适用于特殊内容
- 自定义模式：可自定义分片长度

### 并发设置

```13:13:src/store/tools/subtitle/useSubtitleTranslatorStore.ts
const MAX_CONCURRENCY = 5;
```

## 贡献指南

1. Fork 本仓库
2. 创建你的特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交你的更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 开启一个 Pull Request

## 许可证

MIT License

## 联系方式

- 项目主页：[GitHub](https://github.com/yourusername/FusionKit)
- 问题反馈：[Issues](https://github.com/yourusername/FusionKit/issues)
