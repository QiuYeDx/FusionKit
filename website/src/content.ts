export type Lang = 'zh' | 'en'

export type ToolKey =
  | 'translate'
  | 'convert'
  | 'extract'
  | 'transcribe'
  | 'rename'
  | 'longText'
  | 'audio'

type Item = { title: string; body: string }

export type Content = {
  meta: { title: string; description: string }
  nav: { features: string; agent: string; privacy: string; download: string }
  ui: {
    language: string
    theme: { light: string; dark: string }
    github: string
    skip: string
  }
  hero: {
    notice: string
    noticeLink: string
    title: string
    subtitle: string
    download: { mac: string; windows: string; other: string }
    source: string
    meta: string[]
    shotAlt: string
  }
  pillars: Item[]
  studio: { kicker: string; title: string; body: string; items: Item[]; shotAlt: string }
  agent: {
    kicker: string
    title: string
    body: string
    items: Item[]
    modesTitle: string
    modes: Item[]
    shotAlt: string
    dockTitle: string
    dockBody: string
    dockAlt: string
  }
  knowledge: {
    kicker: string
    title: string
    body: string
    items: Item[]
    table: {
      name: string
      direction: string
      columns: [string, string, string]
      rows: [string, string, 'required' | 'preferred' | 'keep'][]
      levels: { required: string; preferred: string; keep: string }
      footer: string
    }
  }
  tools: {
    kicker: string
    title: string
    body: string
    items: (Item & { key: ToolKey; beta?: string })[]
    extrasTitle: string
    extras: string[]
  }
  privacy: {
    kicker: string
    title: string
    body: string
    columns: [string, string]
    rows: [string, string][]
    keys: string
  }
  download: {
    kicker: string
    title: string
    body: string
    latest: (version: string) => string
    loading: string
    unavailable: string
    allReleases: string
    platforms: { mac: Item & { package: string }; windows: Item & { package: string } }
    button: string
    stepsTitle: string
    steps: Item[]
    note: string
  }
  footer: {
    tagline: string
    license: string
    links: { releases: string; changelog: string; issues: string; source: string }
    madeBy: string
  }
}

export const content: Record<Lang, Content> = {
  zh: {
    meta: {
      title: 'FusionKit · AI 驱动的字幕与翻译桌面工具集',
      description:
        '本地转写音视频，AI 翻译与修订字幕，用对话完成整套流程。支持 macOS 与 Windows，接入你自己的模型服务。',
    },
    nav: { features: '功能', agent: 'Agent', privacy: '隐私', download: '下载' },
    ui: {
      language: 'English',
      theme: { light: '切换到浅色', dark: '切换到深色' },
      github: '在 GitHub 上查看源码',
      skip: '跳到正文',
    },
    hero: {
      notice: '新版发布：字幕工作台、翻译资料与多会话 Agent',
      noticeLink: '查看更新日志',
      title: 'AI 驱动的\u200b字幕与翻译\u200b桌面工具集',
      subtitle:
        '把本地转写、AI 翻译与修订、格式转换和批量导出放进同一个工作台。用一句话说明要做的事，Agent 会准备好任务，在你确认后完成整套流程。',
      download: { mac: '下载 macOS 版', windows: '下载 Windows 版', other: '下载 FusionKit' },
      source: 'GitHub 源码',
      meta: ['macOS Apple Silicon', 'Windows x64', '开源 · 非商业许可'],
      shotAlt: '字幕工作台：左侧为字幕文档库，右侧为日语原文与中文译文的对照预览',
    },
    pillars: [
      { title: '一站式工作台', body: '转写、翻译、校对、试听原声、导出，全部在一个地方完成。' },
      { title: '本地优先', body: '音视频用设备上的 Whisper 模型转写，媒体文件不会上传，字幕文档保存在本机。' },
      { title: '可审可撤', body: 'AI 的每一次修改都先预览差异，由你确认后才写入，并且可以撤销。' },
      { title: '接入你自己的模型', body: '支持 DeepSeek、OpenAI 及任意 OpenAI 兼容接口，Token 用量与费用实时可见。' },
    ],
    studio: {
      kicker: '字幕工作台',
      title: '把字幕当作\u200b可以持续编辑的文档',
      body: '导入、转写、翻译、校对和导出都在同一份文档上进行，关闭应用后再打开也不会丢失。',
      items: [
        { title: '导入与整理', body: 'SRT、LRC、VTT、ASS、SSA、SBV 导入导出；双语字幕自动拆分为原文与译文，可保留多个译文轨。' },
        { title: '本地转写', body: '拖入音频或视频，选择音轨、模型与 VAD 在本机生成字幕，完成后可自动翻译并导出到媒体文件旁。' },
        { title: '翻译与 AI 修订', body: '用自然语言描述要改的地方，如“统一人名写法”，AI 逐条给出修订和差异，确认后一次应用。' },
        { title: '边听边校对', body: '试听每句对应的原声，用快捷键重新定时间，或用本机模型重新识别某几句。' },
        { title: '批量与撤销', body: '搜索、筛选、跨页多选后批量翻译、导出或删除；所有编辑都支持撤销与重做。' },
      ],
      shotAlt: '字幕工作台中的日语原文与中文译文对照预览',
    },
    agent: {
      kicker: 'FusionKit Agent',
      title: '一句话，交给 Agent',
      body: '在首页用对话驱动整个应用：查找文档、导入字幕、准备转写与翻译任务，一次交办“转写 → 翻译 → 保存字幕”，Agent 问清设置后自动完成并汇报结果。',
      items: [
        { title: '调用真实工具', body: '字幕翻译、格式转换、语言提取、文件名翻译等工具都能调用，并读取任务的真实进度。' },
        { title: '可见的执行计划', body: '复杂请求会生成带步骤与进度的计划，阻塞原因一目了然。' },
        { title: '整理翻译资料', body: '可以把译法记入资料集；联网查证译名默认关闭，开启后也只发送检索词。' },
      ],
      modesTitle: '三种执行模式',
      modes: [
        { title: '仅添加', body: '只准备任务，由你手动开始' },
        { title: '询问执行', body: '写入操作以卡片列出，确认后生效' },
        { title: '自动执行', body: '按计划直接完成并汇报' },
      ],
      shotAlt: 'FusionKit Agent 根据一句话找到未翻译的字幕，并准备好待确认的翻译任务',
      dockTitle: '在任何页面\u200b随时唤起',
      dockBody:
        '左下角的 Agent 入口会展开悬浮面板，与首页共享同一个会话。Agent 了解你所在的页面：在工作台里可以直接说“这个词都应该是另一种写法”，在工具页可以说“把目标语言改成英文”。',
      dockAlt: '在字幕工作台中展开的 Agent 悬浮面板',
    },
    knowledge: {
      kicker: '翻译资料',
      title: '人名、称谓和术语，前后一致',
      body: '按作品或主播把术语、翻译要求和背景整理成资料集。翻译与修订时勾选资料集或直接选用预设。',
      items: [
        { title: '表格里直接录入', body: '保存即生效，可单条停用，删除后可撤销。' },
        { title: '本地保存，随时分享', body: '资料保存在本机，支持 .fktk.json 导入导出与差异预览。' },
        { title: '版本固定', body: '任务会固定所用资料的版本，事后修改资料不会改写历史任务。' },
      ],
      table: {
        name: '灯台守の夜',
        direction: '日语 → 中文',
        columns: ['原文', '译文', '要求'],
        rows: [
          ['灯台守', '守灯人', 'required'],
          ['ミナト', '湊', 'required'],
          ['おじいちゃん', '爷爷', 'preferred'],
          ['SOS', 'SOS', 'keep'],
        ],
        levels: { required: '必须', preferred: '优先', keep: '保留原文' },
        footer: '说明 · 角色称呼保持口语化，不加敬称',
      },
    },
    tools: {
      kicker: '更多工具',
      title: '成熟可用的\u200b独立工具',
      body: '工作台之外，这些工具可以单独打开，也都能交给 Agent 调用。',
      items: [
        { key: 'translate', title: '字幕 AI 翻译', body: '分片并发翻译 LRC / SRT，支持 9 种语言、双语或仅译文输出，中断后可从恢复清单继续。' },
        { key: 'convert', title: '字幕格式转换', body: '在 SRT、VTT、LRC、ASS、SSA、SBV 之间互转，尽量保留 ASS / SSA 的样式与对齐。' },
        { key: 'extract', title: '字幕语言提取', body: '从双语字幕中提取指定语言，输出保持原格式。' },
        { key: 'transcribe', title: '本地字幕转写', body: '用本地 Whisper 模型批量把音视频转写为 SRT / LRC，可交接给字幕翻译。' },
        { key: 'rename', title: '文件名 / 文件夹名翻译', body: 'AI 翻译名称，核对后重命名；由深到浅执行，失败自动回滚，完成后可撤销。' },
        { key: 'longText', title: '长文本翻译', beta: 'Beta', body: '面向小说和长文档的 TXT 翻译，支持连贯串行模式、暂停恢复与从指定分片重翻。' },
        { key: 'audio', title: '音频工具箱', body: '音频转文本、文本转语音、实时字幕与实时双向语音，使用 OpenAI 或 MiMo 的音频接口。' },
      ],
      extrasTitle: '此外',
      extras: ['深色 / 浅色主题', '简繁中文、English、日本語界面', '应用内自动更新', '系统 / 自定义代理', '任务完成通知与防休眠'],
    },
    privacy: {
      kicker: '隐私与数据',
      title: '没有自己的服务器，也不收集使用数据',
      body: '除检查更新外，数据只会发往你自己配置的服务。',
      columns: ['场景', '发送什么、发往哪里'],
      rows: [
        ['本地转写', '默认离线，媒体与字幕不出本机；仅下载模型资源时访问固定的下载地址'],
        ['AI 翻译、修订与 Agent', '字幕或文本内容发送到你在设置中配置的模型服务'],
        ['音频工具箱', '音频文件、录音或麦克风内容发送到你选择的音频服务'],
        ['联网查证（默认关闭）', '只发送检索词与网页链接，不发送字幕或翻译资料'],
        ['检查更新', '访问 GitHub Releases 获取新版本信息'],
      ],
      keys: 'API Key 保存在本机的应用设置中，只用于请求你配置的服务，不会写入恢复清单、任务数据或错误详情。',
    },
    download: {
      kicker: '下载',
      title: '开始使用 FusionKit',
      body: '免费下载，源码以 PolyForm Noncommercial 许可发布。',
      latest: (version) => `最新正式版 ${version}`,
      loading: '正在获取最新版本…',
      unavailable: '最新版本见 GitHub Releases',
      allReleases: '所有版本',
      platforms: {
        mac: { title: 'macOS', body: 'Apple Silicon（arm64）', package: '.dmg / .zip' },
        windows: { title: 'Windows', body: 'x64', package: '.exe 安装程序' },
      },
      button: '下载',
      stepsTitle: '首次使用',
      steps: [
        { title: '添加模型配置', body: '在“设置 → AI 模型”填写 API 地址、Key 和模型名，内置 DeepSeek 与 OpenAI 预设。' },
        { title: '下载转写模型', body: '使用本地转写前，在转写页下载推荐的 Whisper 模型；模型按需下载，不包含在安装包中。' },
        { title: '告诉 Agent 要做什么', body: '回到首页直接对话，或从“工具”页打开具体工具手动操作。' },
      ],
      note: '本地转写支持 Windows x64（CPU / CUDA）与 macOS arm64（Metal / CPU），速度取决于设备性能、模型大小和媒体内容。',
    },
    footer: {
      tagline: 'AI 驱动的字幕与翻译桌面工具集',
      license: 'PolyForm Noncommercial License 1.0.0',
      links: { releases: '版本发布', changelog: '更新日志', issues: '反馈问题', source: '源码' },
      madeBy: '由 QiuYeDx 制作',
    },
  },
  en: {
    meta: {
      title: 'FusionKit · AI-powered subtitle and translation toolkit',
      description:
        'Transcribe on your device, translate and revise subtitles with AI, and hand the whole workflow to an agent. For macOS and Windows, with your own model API key.',
    },
    nav: { features: 'Features', agent: 'Agent', privacy: 'Privacy', download: 'Download' },
    ui: {
      language: '简体中文',
      theme: { light: 'Switch to light theme', dark: 'Switch to dark theme' },
      github: 'View the source on GitHub',
      skip: 'Skip to content',
    },
    hero: {
      notice: 'Now available: Subtitle Studio, translation materials and multi-session Agent',
      noticeLink: 'Read the changelog',
      title: 'The AI-powered desktop toolkit for subtitles and translation',
      subtitle:
        'On-device transcription, AI translation and revision, format conversion and batch export in one workspace. Say what you need in one sentence, and the Agent prepares the tasks and finishes the workflow once you confirm.',
      download: { mac: 'Download for macOS', windows: 'Download for Windows', other: 'Download FusionKit' },
      source: 'Source on GitHub',
      meta: ['macOS Apple Silicon', 'Windows x64', 'Source available · noncommercial'],
      shotAlt: 'Subtitle Studio: the document library on the left, Japanese source next to the Chinese translation on the right',
    },
    pillars: [
      { title: 'One workspace', body: 'Transcribe, translate, proofread, listen to the original audio and export, all in one place.' },
      { title: 'Local first', body: 'Media is transcribed with Whisper on your own device and never uploaded; documents stay on your computer.' },
      { title: 'Reviewable, reversible', body: 'Every AI change is shown as a diff first, written only after you confirm, and can be undone.' },
      { title: 'Bring your own model', body: 'DeepSeek, OpenAI or any OpenAI-compatible service, with live token usage and cost.' },
    ],
    studio: {
      kicker: 'Subtitle Studio',
      title: 'Subtitles as documents you keep working on',
      body: 'Import, transcribe, translate, proofread and export on the same document, and find it all still there after a restart.',
      items: [
        { title: 'Import and organize', body: 'SRT, LRC, VTT, ASS, SSA and SBV in and out. Bilingual files split into source and translation, with several translation tracks.' },
        { title: 'Transcribe locally', body: 'Drop in audio or video, pick the track, model and VAD, and optionally translate and export next to the media when done.' },
        { title: 'Translate and revise', body: 'Describe a fix in plain words, like "spell this name the same way everywhere", and apply cue-by-cue diffs in one step.' },
        { title: 'Proofread by ear', body: 'Play the original audio of any cue, retime while listening with shortcuts, or re-recognize a few lines locally.' },
        { title: 'Batch and undo', body: 'Search, filter and select across pages to translate, export or delete in bulk. Every edit can be undone.' },
      ],
      shotAlt: 'Japanese source next to the Chinese translation in Subtitle Studio',
    },
    agent: {
      kicker: 'FusionKit Agent',
      title: 'Say it once, let the Agent handle the rest',
      body: 'Drive the whole app from a conversation: find documents, import subtitles, prepare tasks, or hand over "transcribe → translate → save subtitles" in one go. The Agent asks for the settings up front, then finishes and reports back.',
      items: [
        { title: 'Real tools, real progress', body: 'Subtitle translation, format conversion, language extraction, file name translation and more, with live task progress.' },
        { title: 'Visible plans', body: 'Complex requests get a step-by-step plan with progress and the reason anything is blocked.' },
        { title: 'Curate materials', body: 'Save renderings to your translation materials. Web lookup is off by default and only sends search terms.' },
      ],
      modesTitle: 'Three execution modes',
      modes: [
        { title: 'Queue Only', body: 'Prepares tasks for you to start' },
        { title: 'Ask Before Execute', body: 'Writes wait on a card for your OK' },
        { title: 'Auto Execute', body: 'Follows the plan and reports back' },
      ],
      shotAlt: 'FusionKit Agent finds the untranslated subtitles from one request and prepares a translation waiting for confirmation',
      dockTitle: 'One tap away on every page',
      dockBody:
        'The Agent button in the bottom-left corner opens a floating panel that shares the home page conversation. It knows which page you are on: in the Studio say "this word should always be spelled like that", on a tool page "switch the target language to English".',
      dockAlt: 'The floating Agent panel open in Subtitle Studio',
    },
    knowledge: {
      kicker: 'Translation materials',
      title: 'Names, forms of address and terms that stay consistent',
      body: 'Group terms, requirements and background into a collection per title or streamer, then tick collections or pick a preset when translating or revising.',
      items: [
        { title: 'Type straight into the table', body: 'Terms apply as soon as they are saved, can be disabled one by one, and deletes can be undone.' },
        { title: 'Local, and easy to share', body: 'Stored on your computer; share as .fktk.json files with diff previews on import.' },
        { title: 'Pinned versions', body: 'Each task pins the materials it used, so later edits never rewrite past tasks.' },
      ],
      table: {
        name: 'Lighthouse Nights',
        direction: 'Japanese → English',
        columns: ['Source', 'Translation', 'Rule'],
        rows: [
          ['灯台守', 'lighthouse keeper', 'required'],
          ['ミナト', 'Minato', 'required'],
          ['おじいちゃん', 'Grandpa', 'preferred'],
          ['SOS', 'SOS', 'keep'],
        ],
        levels: { required: 'Required', preferred: 'Preferred', keep: 'Keep source' },
        footer: 'Notes · keep how characters address each other casual',
      },
    },
    tools: {
      kicker: 'More tools',
      title: 'Proven tools that work on their own',
      body: 'Beyond the Studio, each tool opens on its own, and the Agent can use every one of them.',
      items: [
        { key: 'translate', title: 'AI subtitle translation', body: 'Translates LRC / SRT in parallel chunks into 9 languages, bilingual or translation only, and resumes from a recovery file.' },
        { key: 'convert', title: 'Subtitle format conversion', body: 'Converts between SRT, VTT, LRC, ASS, SSA and SBV, keeping ASS / SSA styling and alignment where possible.' },
        { key: 'extract', title: 'Subtitle language extraction', body: 'Extracts one language from bilingual subtitles, keeping the original format.' },
        { key: 'transcribe', title: 'Local subtitle transcription', body: 'Batch-transcribes audio and video to SRT / LRC with local Whisper models, ready to hand to translation.' },
        { key: 'rename', title: 'File and folder name translation', body: 'AI-translates names for review before renaming. Runs deepest-first, rolls back on failure and can be undone.' },
        { key: 'longText', title: 'Long text translation', beta: 'Beta', body: 'Translates TXT novels and long documents, with a coherent sequential mode, pause and resume, and partial re-translation.' },
        { key: 'audio', title: 'Audio toolbox', body: 'Speech to text, text to speech, live captions and real-time voice, using OpenAI or MiMo audio APIs.' },
      ],
      extrasTitle: 'Also included',
      extras: ['Dark and light themes', 'Four interface languages', 'In-app updates', 'System or custom proxy', 'Notifications, no sleep mid-task'],
    },
    privacy: {
      kicker: 'Privacy and data',
      title: 'No server of its own, and no usage data collected',
      body: 'Apart from update checks, data only goes to the services you configure.',
      columns: ['When', 'What is sent, and where'],
      rows: [
        ['Local transcription', 'Nothing by default: media and subtitles stay on your device. Only model downloads reach fixed download addresses'],
        ['AI translation, revision and the Agent', 'Subtitle or text content goes to the model service in your settings'],
        ['Audio toolbox', 'Audio files, recordings or microphone input go to the audio service you choose'],
        ['Web lookup (off by default)', 'Only search terms and page links; never subtitles or translation materials'],
        ['Update checks', 'GitHub Releases, for new version information'],
      ],
      keys: 'API keys stay in the app’s local settings and are used only for the services you configured. They are never written to recovery files, task data or error details.',
    },
    download: {
      kicker: 'Download',
      title: 'Get started with FusionKit',
      body: 'Free to download. The source is published under the PolyForm Noncommercial license.',
      latest: (version) => `Latest stable ${version}`,
      loading: 'Checking the latest version…',
      unavailable: 'See GitHub Releases for the latest version',
      allReleases: 'All releases',
      platforms: {
        mac: { title: 'macOS', body: 'Apple Silicon (arm64)', package: '.dmg / .zip' },
        windows: { title: 'Windows', body: 'x64', package: '.exe installer' },
      },
      button: 'Download',
      stepsTitle: 'Getting started',
      steps: [
        { title: 'Add a model profile', body: 'Open Setting → AI Model and enter the API endpoint, key and model name. DeepSeek and OpenAI presets are built in.' },
        { title: 'Download a transcription model', body: 'Before transcribing locally, download the recommended Whisper model on the transcription page. Models are not in the installer.' },
        { title: 'Tell the Agent what you need', body: 'Go back to the home page and just ask, or open a tool from the Tools page.' },
      ],
      note: 'Local transcription runs on Windows x64 (CPU / CUDA) and macOS arm64 (Metal / CPU); speed depends on your hardware, the model size and the media.',
    },
    footer: {
      tagline: 'The AI-powered desktop toolkit for subtitles and translation',
      license: 'PolyForm Noncommercial License 1.0.0',
      links: { releases: 'Releases', changelog: 'Changelog', issues: 'Report an issue', source: 'Source' },
      madeBy: 'Made by QiuYeDx',
    },
  },
}
