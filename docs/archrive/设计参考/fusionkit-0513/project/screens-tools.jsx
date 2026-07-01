/* Tools list page — categorized tool grid w/ identity colors
 * Supports two layouts: "card" (visual grid) and "list" (compact rows)
 */

function ToolsScreen({ onOpen, layout = "card" }) {
  const categories = [
    {
      key: "subtitle", title: "字幕工具箱",
      hint: "导入字幕文件并完成翻译、格式转换与语言提取等任务。",
      items: [
        {
          id: "translator", title: "字幕翻译", icon: "languages", tone: "var(--t-translator)",
          desc: "调用 AI 大模型完成 LRC / SRT 字幕的高质量翻译。",
          chips: [
            { label: "9 种语言", icon: "globe" },
            { label: "DeepSeek · OpenAI", icon: "cpu" },
            { label: "双语 / 仅译文", icon: "fileText" },
          ],
          status: "stable",
        },
        {
          id: "converter", title: "字幕格式转换", icon: "refresh", tone: "var(--t-converter)",
          desc: "在 SRT / VTT / LRC 三种主流格式间自由转换。",
          chips: [
            { label: "6 条转换路径", icon: "arrowSwap" },
            { label: "重名策略可选", icon: "edit" },
          ],
          status: "stable",
        },
        {
          id: "extractor", title: "字幕语言提取", icon: "fileText", tone: "var(--t-extractor)",
          desc: "从双语字幕中提取中文或日文。基于多维启发式识别。",
          chips: [
            { label: "中 / 日", icon: "languages" },
            { label: "LRC · SRT", icon: "fileText" },
          ],
          status: "stable",
        },
      ],
    },
    {
      key: "music", title: "音乐工具箱",
      hint: "针对音频文件的批处理与转换工具。",
      items: [
        {
          id: "decrypt", title: "付费音乐解密转换", icon: "music", tone: "var(--t-music)",
          desc: "将常见的加密音频格式还原为标准编码。",
          chips: [{ label: "开发中", icon: "clock" }],
          status: "soon",
        },
      ],
    },
    {
      key: "rename", title: "文件管理",
      hint: "批量处理本地文件名与目录结构。",
      items: [
        {
          id: "rename", title: "批量文件重命名", icon: "edit", tone: "var(--t-rename)",
          desc: "按规则批量重命名文件,支持正则与序号占位符。",
          chips: [{ label: "开发中", icon: "clock" }],
          status: "soon",
        },
      ],
    },
  ];

  return (
    <div style={{ padding: "32px 36px 120px", maxWidth: 1100, margin: "0 auto" }}>
      <PageHeader
        title="工具"
        subtitle="一站式跨平台桌面工具集合。选择下方任一工具即可开始使用。"
        right={
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Tag tone="outline" mono>v0.5.0</Tag>
            <Tag tone="green" mono>3 / 5 可用</Tag>
          </div>
        }
      />

      <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
        {categories.map((cat) => (
          <CategoryBlock key={cat.key} cat={cat} layout={layout} onOpen={onOpen} />
        ))}
      </div>
    </div>
  );
}

function CategoryBlock({ cat, layout, onOpen }) {
  return (
    <section>
      {/* category header */}
      <div style={{
        display: "flex", alignItems: "baseline", gap: 14,
        marginBottom: 14, paddingLeft: 2,
      }}>
        <h2 style={{
          margin: 0, fontSize: 13, fontWeight: 600, color: "var(--fg)",
          textTransform: "uppercase", letterSpacing: "0.08em",
        }}>{cat.title}</h2>
        <div style={{ height: 1, background: "var(--line)", flex: 1 }} />
        <span style={{ fontSize: 12, color: "var(--mute)" }}>{cat.hint}</span>
      </div>

      {layout === "card" ? (
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: 12,
        }}>
          {cat.items.map((it) => (
            <ToolCard key={it.id} tool={it} onOpen={onOpen} />
          ))}
        </div>
      ) : (
        <div style={{
          background: "var(--card)", border: "1px solid var(--line)",
          borderRadius: 14, overflow: "hidden",
        }}>
          {cat.items.map((it, i) => (
            <React.Fragment key={it.id}>
              {i > 0 && <Divider />}
              <ToolRow tool={it} onOpen={onOpen} />
            </React.Fragment>
          ))}
        </div>
      )}
    </section>
  );
}

function ToolCard({ tool, onOpen }) {
  const isSoon = tool.status === "soon";
  const click = () => !isSoon && onOpen?.(tool.id);
  return (
    <div
      onClick={click}
      style={{
        position: "relative",
        background: "var(--card)",
        border: isSoon ? "1px dashed var(--line-strong)" : "1px solid var(--line)",
        borderRadius: 14, padding: 16,
        cursor: isSoon ? "default" : "pointer",
        opacity: isSoon ? 0.65 : 1,
        transition: "all .18s ease",
        overflow: "hidden",
      }}
      onMouseEnter={(e) => {
        if (isSoon) return;
        e.currentTarget.style.borderColor = "color-mix(in oklch, " + tool.tone + " 50%, var(--line))";
        e.currentTarget.style.transform = "translateY(-1px)";
        e.currentTarget.style.boxShadow = "0 6px 20px -8px rgba(0,0,0,0.12)";
      }}
      onMouseLeave={(e) => {
        if (isSoon) return;
        e.currentTarget.style.borderColor = "var(--line)";
        e.currentTarget.style.transform = "translateY(0)";
        e.currentTarget.style.boxShadow = "none";
      }}
    >
      {/* top stripe */}
      {!isSoon && (
        <div style={{
          position: "absolute", top: 0, left: 16, right: 16, height: 2,
          background: tool.tone, borderRadius: "0 0 999px 999px",
          opacity: 0.85,
        }} />
      )}

      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <ToolBadge tone={tool.tone} icon={tool.icon} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: "var(--fg)" }}>{tool.title}</h3>
            {isSoon && <Tag tone="outline" style={{ fontSize: 10 }}>即将推出</Tag>}
          </div>
          <p style={{
            margin: "4px 0 0", fontSize: 12.5, lineHeight: 1.5,
            color: "var(--mute)",
          }}>{tool.desc}</p>
        </div>
        {!isSoon && (
          <Icon name="arrowRight" size={15} style={{ color: "var(--mute)", marginTop: 4 }} />
        )}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 14 }}>
        {tool.chips.map((c, i) => (
          <span key={i} style={{
            display: "inline-flex", alignItems: "center", gap: 4,
            padding: "3px 8px", borderRadius: 6,
            background: "var(--bg-subtle)",
            border: "1px solid var(--line)",
            fontSize: 11, color: "var(--fg-2)", fontWeight: 500,
          }}>
            <Icon name={c.icon} size={11} style={{ color: tool.tone }} />
            {c.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function ToolRow({ tool, onOpen }) {
  const isSoon = tool.status === "soon";
  return (
    <div
      onClick={() => !isSoon && onOpen?.(tool.id)}
      style={{
        display: "flex", alignItems: "center", gap: 14, padding: "14px 18px",
        cursor: isSoon ? "default" : "pointer",
        opacity: isSoon ? 0.6 : 1,
        transition: "background .15s ease",
      }}
      onMouseEnter={(e) => !isSoon && (e.currentTarget.style.background = "var(--bg-subtle)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <ToolBadge tone={tool.tone} icon={tool.icon} size={32} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "var(--fg)" }}>{tool.title}</h3>
          {isSoon && <Tag tone="outline" style={{ fontSize: 10 }}>即将推出</Tag>}
        </div>
        <p style={{ margin: "1px 0 0", fontSize: 12.5, color: "var(--mute)", lineHeight: 1.45 }}>{tool.desc}</p>
      </div>
      <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
        {tool.chips.map((c, i) => (
          <span key={i} style={{
            fontSize: 11, color: "var(--mute)", padding: "2px 8px",
            border: "1px solid var(--line)", borderRadius: 999,
          }}>{c.label}</span>
        ))}
      </div>
      {!isSoon && <Icon name="chevRight" size={15} style={{ color: "var(--mute)", flexShrink: 0 }} />}
    </div>
  );
}

window.ToolsScreen = ToolsScreen;
