export type Lang = 'zh' | 'en'

export type ToolKey =
  | 'translate'
  | 'convert'
  | 'extract'
  | 'transcribe'
  | 'rename'
  | 'longText'

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
    external: {
      label: string
      title: string
      body: string
      clientsLabel: string
      clients: string[]
      steps: Item[]
      note: string
      demo: {
        label: string
        client: string
        prompt: string
        calls: { tool: string; result: string; confirmed?: boolean }[]
        confirmed: string
        reply: string
      }
    }
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
        '本地转写，AI 翻译与修订，一句话交给 Agent。支持 macOS 与 Windows，接入你自己的模型，或让 Claude Code、Codex、Cursor 直接操作。',
    },
    nav: { features: '功能', agent: 'Agent', privacy: '隐私', download: '下载' },
    ui: {
      language: 'English',
      theme: { light: '切换到浅色', dark: '切换到深色' },
      github: '在 GitHub 上查看源码',
      skip: '跳到正文',
    },
    hero: {
      notice: '新：让 Claude Code、Codex、Cursor 直接操作 FusionKit',
      title: '字幕与翻译，\u200b一站完成。',
      subtitle: '转写、翻译、校对、导出，都在一个工作台里。\u200b剩下的，说一句交给 Agent。',
      download: { mac: '下载 macOS 版', windows: '下载 Windows 版', other: '下载 FusionKit' },
      source: 'GitHub 源码',
      meta: ['macOS Apple Silicon', 'Windows x64', '开源 · 非商业许可'],
      shotAlt: '字幕工作台：左侧为字幕文档库，右侧为日语原文与中文译文的对照预览',
    },
    pillars: [
      { title: '一站完成', body: '转写、翻译、校对、导出，一个工作台。' },
      { title: '本地优先', body: '媒体在本机转写，不上传。' },
      { title: '可审可撤', body: 'AI 的修改先预览，确认后写入，随时撤销。' },
      { title: '自带模型', body: 'DeepSeek、OpenAI 或任意兼容接口，也可交给外部 Agent。' },
    ],
    studio: {
      kicker: '字幕工作台',
      title: '字幕，像文档一样编辑。',
      body: '导入、转写、翻译、校对、导出，都在同一份文档上完成。',
      items: [
        { title: '导入与整理', body: 'SRT、VTT、ASS 等六种格式；双语字幕自动拆分为原文与译文。' },
        { title: '本地转写', body: '拖入音视频，在本机生成字幕，完成后可自动翻译。' },
        { title: 'AI 修订', body: '说一句“统一人名写法”，逐条预览差异，一次应用。' },
        { title: '边听边校', body: '试听每句原声，用快捷键重新定时，或重新识别。' },
        { title: '查找与调整', body: '正则查找替换，整体平移或按帧率伸缩时间。每一步都能撤销。' },
      ],
      shotAlt: '字幕工作台中的日语原文与中文译文对照预览',
    },
    agent: {
      kicker: 'FusionKit Agent',
      title: '说一句，\u200b剩下的交给 Agent。',
      body: '从找文档到“转写 → 翻译 → 导出”，Agent 先问清设置，再自动完成并汇报。',
      items: [
        { title: '真实工具', body: '调用应用里的每个工具，读取真实进度。' },
        { title: '可见计划', body: '复杂请求拆成步骤，进展一目了然。' },
        { title: '整理资料', body: '把译法记进资料集；联网查证默认关闭。' },
      ],
      modesTitle: '三种执行模式',
      modes: [
        { title: '仅添加', body: '只准备任务' },
        { title: '询问执行', body: '写入前等你确认' },
        { title: '自动执行', body: '按计划完成并汇报' },
      ],
      shotAlt: 'FusionKit Agent 根据一句话找到未翻译的字幕，并准备好待确认的翻译任务',
      dockTitle: '每个页面，\u200b随时唤起。',
      dockBody: '左下角展开悬浮面板，与首页共享会话，也知道你正在哪个页面。',
      dockAlt: '在字幕工作台中展开的 Agent 悬浮面板',
      external: {
        label: '外部 Agent · MCP',
        title: '或者，\u200b交给你正在用的 Agent。',
        body: 'Claude Code、Codex、Cursor 可以读取工作台、亲自撰写译文并导出，FusionKit 里无需配置 API Key。',
        clientsLabel: '支持的客户端',
        clients: ['Claude Code', 'Claude 应用', 'Codex', 'Cursor', '其他 MCP 客户端'],
        steps: [
          { title: '开启连接', body: '设置 → 外部 Agent，默认关闭。' },
          { title: '接入客户端', body: '复制命令，或一键写入配置。' },
          { title: '直接提需求', body: '导入、写入、导出前都会请你确认。' },
        ],
        note: '只监听本机并需要令牌。写入的译文标为未复核，可以撤销，每一步都有记录。',
        demo: {
          label: '外部 Agent 通过 MCP 操作 FusionKit 的示例过程',
          client: 'Claude Code',
          prompt: '把「灯台守の夜」翻译成中文，导出 SRT 到原文件旁边',
          calls: [
            { tool: 'list_studio_documents', result: '找到 1 份文档' },
            { tool: 'read_studio_document', result: '248 条字幕 · 日语' },
            { tool: 'create_studio_translation_track', result: '新建译文轨“Claude Code”', confirmed: true },
            { tool: 'write_studio_translations', result: '写入 248 条译文 · 未复核' },
            { tool: 'export_studio_document', result: '灯台守の夜.zh.srt', confirmed: true },
          ],
          confirmed: '已确认',
          reply: '已写入 248 条中文译文并导出 SRT，译文在工作台中标为待复核。',
        },
      },
    },
    knowledge: {
      kicker: '翻译资料',
      title: '人名与术语，\u200b前后一致。',
      body: '按作品整理术语和翻译要求，翻译时勾选即可。',
      items: [
        { title: '直接录入', body: '在表格里填写，保存即生效。' },
        { title: '本地保存', body: '以 .fktk.json 导入导出，先预览差异。' },
        { title: '版本固定', body: '事后修改资料，不会改写历史任务。' },
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
      title: '独立工具，\u200b随手可用。',
      body: '每个工具都能单独打开，也都能交给 Agent。',
      items: [
        { key: 'translate', title: '字幕 AI 翻译', body: '分片并发翻译 LRC / SRT，中断后可继续。' },
        { key: 'convert', title: '格式转换', body: 'SRT、VTT、LRC、ASS、SSA、SBV 互转，尽量保留样式。' },
        { key: 'extract', title: '语言提取', body: '从双语字幕中提取一种语言。' },
        { key: 'transcribe', title: '批量转写', body: '用本地 Whisper 批量生成 SRT / LRC。' },
        { key: 'rename', title: '文件名翻译', body: 'AI 翻译名称，核对后重命名，可以撤销。' },
        { key: 'longText', title: '长文本翻译', beta: 'Beta', body: '小说与长文档，支持暂停与恢复。' },
      ],
      extrasTitle: '此外',
      extras: ['深色 / 浅色主题', '简繁中文、English、日本語界面', '应用内自动更新', '系统 / 自定义代理', '完成通知与防休眠'],
    },
    privacy: {
      kicker: '隐私',
      title: '没有服务器，\u200b不收集数据。',
      body: '除检查更新外，数据只发往你自己配置的服务。',
      columns: ['场景', '发送什么、发往哪里'],
      rows: [
        ['本地转写', '默认离线，媒体与字幕不出本机'],
        ['AI 翻译与 Agent', '内容发往你配置的模型服务'],
        ['联网查证（默认关闭）', '只发送检索词'],
        ['外部 Agent（默认关闭）', '只监听 127.0.0.1，需要令牌'],
        ['检查更新', '访问 GitHub Releases'],
      ],
      keys: 'API Key 只保存在本机，不会写入任务数据或错误详情。',
    },
    download: {
      kicker: '下载',
      title: '开始使用 FusionKit。',
      body: '免费下载，源码以非商业许可公开。',
      latest: (version) => `最新正式版 ${version}`,
      loading: '正在获取最新版本…',
      unavailable: '最新版本见 GitHub Releases',
      allReleases: '所有版本',
      platforms: {
        mac: { title: 'macOS', body: 'Apple Silicon（arm64）', package: '.dmg / .zip' },
        windows: { title: 'Windows', body: 'x64', package: '.exe 安装程序' },
      },
      button: '下载',
      stepsTitle: '三步上手',
      steps: [
        { title: '添加模型', body: '设置 → AI 模型，填入地址、Key 与模型名。只用外部 Agent 可跳过。' },
        { title: '下载转写模型', body: '首次本地转写前，下载推荐的 Whisper 模型。' },
        { title: '开始对话', body: '回到首页，告诉 Agent 要做什么。' },
      ],
      note: '本地转写支持 Windows x64（CPU / CUDA）与 macOS arm64（Metal / CPU）。',
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
        'Transcribe on your device, translate and revise with AI, and hand the rest to an agent. For macOS and Windows, with your own model or driven by Claude Code, Codex and Cursor.',
    },
    nav: { features: 'Features', agent: 'Agent', privacy: 'Privacy', download: 'Download' },
    ui: {
      language: '简体中文',
      theme: { light: 'Switch to light theme', dark: 'Switch to dark theme' },
      github: 'View the source on GitHub',
      skip: 'Skip to content',
    },
    hero: {
      notice: 'New: Claude Code, Codex and Cursor can drive FusionKit',
      title: 'Subtitles and translation. \u200bAll in one place.',
      subtitle: 'Transcribe, translate, proofread and export in one workspace. For everything else, just ask the Agent.',
      download: { mac: 'Download for macOS', windows: 'Download for Windows', other: 'Download FusionKit' },
      source: 'Source on GitHub',
      meta: ['macOS Apple Silicon', 'Windows x64', 'Source available · noncommercial'],
      shotAlt: 'Subtitle Studio: the document library on the left, Japanese source next to the Chinese translation on the right',
    },
    pillars: [
      { title: 'All in one', body: 'Transcribe, translate, proofread and export in one workspace.' },
      { title: 'Local first', body: 'Media is transcribed on your device and never uploaded.' },
      { title: 'Reviewable', body: 'Every AI change is previewed, confirmed and undoable.' },
      { title: 'Your model', body: 'DeepSeek, OpenAI, any compatible API, or an external agent.' },
    ],
    studio: {
      kicker: 'Subtitle Studio',
      title: 'Edit subtitles like documents.',
      body: 'Import, transcribe, translate, proofread and export, all on the same document.',
      items: [
        { title: 'Import', body: 'Six formats including SRT, VTT and ASS. Bilingual files split into source and translation.' },
        { title: 'Transcribe locally', body: 'Drop in audio or video, get subtitles on your device, translated when done if you like.' },
        { title: 'Revise with AI', body: 'Say “spell this name the same way everywhere”, review each diff, apply in one go.' },
        { title: 'Proofread by ear', body: 'Play any cue’s original audio, retime with shortcuts, or re-recognize it.' },
        { title: 'Find and retime', body: 'Regex find and replace; shift timings or stretch them between frame rates. Every edit can be undone.' },
      ],
      shotAlt: 'Japanese source next to the Chinese translation in Subtitle Studio',
    },
    agent: {
      kicker: 'FusionKit Agent',
      title: 'Say it once. The Agent does the rest.',
      body: 'From finding a document to “transcribe → translate → export”, the Agent asks for settings up front, then finishes and reports back.',
      items: [
        { title: 'Real tools', body: 'Uses every tool in the app, with live progress.' },
        { title: 'Visible plans', body: 'Complex requests become steps you can follow.' },
        { title: 'Curated materials', body: 'Saves renderings to your materials. Web lookup is off by default.' },
      ],
      modesTitle: 'Three execution modes',
      modes: [
        { title: 'Queue Only', body: 'Prepares tasks only' },
        { title: 'Ask Before Execute', body: 'Waits for your OK before writing' },
        { title: 'Auto Execute', body: 'Runs the plan, then reports' },
      ],
      shotAlt: 'FusionKit Agent finds the untranslated subtitles from one request and prepares a translation waiting for confirmation',
      dockTitle: 'On every page.',
      dockBody: 'Open the floating panel from the corner. It shares the same conversation and knows which page you are on.',
      dockAlt: 'The floating Agent panel open in Subtitle Studio',
      external: {
        label: 'External agents · MCP',
        title: 'Or hand it to the agent you already use.',
        body: 'Claude Code, Codex and Cursor can read Studio, write their own translations and export, with no API key needed in FusionKit.',
        clientsLabel: 'Works with',
        clients: ['Claude Code', 'Claude app', 'Codex', 'Cursor', 'Other MCP clients'],
        steps: [
          { title: 'Turn it on', body: 'Settings → External agents. Off by default.' },
          { title: 'Connect your client', body: 'Copy a command, or write the config in one click.' },
          { title: 'Just ask', body: 'Imports, writes and exports wait for your OK.' },
        ],
        note: 'Local only, token required. Its translations are marked unreviewed, can be undone, and every step is logged.',
        demo: {
          label: 'An external agent working in FusionKit over MCP',
          client: 'Claude Code',
          prompt: 'Translate 灯台守の夜 into English and export an SRT next to the source file',
          calls: [
            { tool: 'list_studio_documents', result: '1 document found' },
            { tool: 'read_studio_document', result: '248 cues · Japanese' },
            { tool: 'create_studio_translation_track', result: 'Created track “Claude Code”', confirmed: true },
            { tool: 'write_studio_translations', result: '248 translations · unreviewed' },
            { tool: 'export_studio_document', result: '灯台守の夜.en.srt', confirmed: true },
          ],
          confirmed: 'Approved',
          reply: 'Wrote 248 English translations and exported the SRT. They are marked for review in Studio.',
        },
      },
    },
    knowledge: {
      kicker: 'Translation materials',
      title: 'Names and terms, always consistent.',
      body: 'Collect terms and rules per title, then tick them when you translate.',
      items: [
        { title: 'Type and go', body: 'Edit in a table. Saved means applied.' },
        { title: 'Local, shareable', body: 'Import and export .fktk.json with a diff preview.' },
        { title: 'Pinned versions', body: 'Later edits never rewrite past tasks.' },
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
      title: 'Standalone tools, ready when you are.',
      body: 'Open any tool on its own, or let the Agent use it.',
      items: [
        { key: 'translate', title: 'AI subtitle translation', body: 'Parallel chunked LRC / SRT translation that resumes after interruptions.' },
        { key: 'convert', title: 'Format conversion', body: 'Between SRT, VTT, LRC, ASS, SSA and SBV, keeping styles where possible.' },
        { key: 'extract', title: 'Language extraction', body: 'Pull one language out of bilingual subtitles.' },
        { key: 'transcribe', title: 'Batch transcription', body: 'Local Whisper to SRT / LRC, in bulk.' },
        { key: 'rename', title: 'File name translation', body: 'AI-translated names, reviewed before renaming, undoable.' },
        { key: 'longText', title: 'Long text translation', beta: 'Beta', body: 'Novels and long documents, with pause and resume.' },
      ],
      extrasTitle: 'Also included',
      extras: ['Dark and light themes', 'Four interface languages', 'In-app updates', 'System or custom proxy', 'Notifications, no sleep mid-task'],
    },
    privacy: {
      kicker: 'Privacy',
      title: 'No server. No data collected.',
      body: 'Apart from update checks, data only goes to the services you configure.',
      columns: ['When', 'What is sent, and where'],
      rows: [
        ['Local transcription', 'Offline by default; media and subtitles stay on your device'],
        ['AI translation and the Agent', 'Content goes to the model service you set up'],
        ['Web lookup (off by default)', 'Search terms only'],
        ['External agents (off by default)', 'Listens on 127.0.0.1 only, token required'],
        ['Update checks', 'GitHub Releases'],
      ],
      keys: 'API keys stay on your device and are never written to task data or error details.',
    },
    download: {
      kicker: 'Download',
      title: 'Get started with FusionKit.',
      body: 'Free to download. Source available under a noncommercial license.',
      latest: (version) => `Latest stable ${version}`,
      loading: 'Checking the latest version…',
      unavailable: 'See GitHub Releases for the latest version',
      allReleases: 'All releases',
      platforms: {
        mac: { title: 'macOS', body: 'Apple Silicon (arm64)', package: '.dmg / .zip' },
        windows: { title: 'Windows', body: 'x64', package: '.exe installer' },
      },
      button: 'Download',
      stepsTitle: 'Three steps to start',
      steps: [
        { title: 'Add a model', body: 'Setting → AI Model: endpoint, key and model name. Skip it if you only use an external agent.' },
        { title: 'Get a transcription model', body: 'Download the recommended Whisper model before your first local transcription.' },
        { title: 'Start talking', body: 'Tell the Agent what you need on the home page.' },
      ],
      note: 'Local transcription runs on Windows x64 (CPU / CUDA) and macOS arm64 (Metal / CPU).',
    },
    footer: {
      tagline: 'The AI-powered desktop toolkit for subtitles and translation',
      license: 'PolyForm Noncommercial License 1.0.0',
      links: { releases: 'Releases', changelog: 'Changelog', issues: 'Report an issue', source: 'Source' },
      madeBy: 'Made by QiuYeDx',
    },
  },
}

