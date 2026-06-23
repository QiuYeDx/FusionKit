/* About — Hero + Links + Build info
 */

function AboutScreen() {
  return (
    <div style={{ padding: "32px 36px 120px", maxWidth: 900, margin: "0 auto" }}>
      <PageHeader title="关于" subtitle="项目信息、版本、链接与构建详情。" />

      {/* ── Hero card ── */}
      <div style={{
        position: "relative",
        background: "var(--card)", border: "1px solid var(--line)", borderRadius: 18,
        padding: 28, overflow: "hidden", marginBottom: 14,
      }}>
        {/* subtle radial accent */}
        <div style={{
          position: "absolute", top: -40, right: -40, width: 240, height: 240,
          borderRadius: "50%",
          background: "radial-gradient(circle, color-mix(in oklch, var(--acc) 18%, transparent), transparent 70%)",
          pointerEvents: "none",
        }} />

        <div style={{ display: "flex", alignItems: "flex-start", gap: 20, position: "relative" }}>
          <FKLogo size={68} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <h2 style={{ margin: 0, fontSize: 24, fontWeight: 600, letterSpacing: "-0.02em" }}>
                FusionKit
              </h2>
              <Tag tone="outline" mono>v0.5.0</Tag>
              <Tag tone="green">最新</Tag>
            </div>
            <p style={{
              margin: "6px 0 0", fontSize: 13.5, color: "var(--mute)", maxWidth: 480, lineHeight: 1.55,
            }}>
              一站式跨平台桌面工具集合,内置 AI 助手,可通过自然语言对话驱动字幕翻译、格式转换与语言提取等操作。
            </p>

            <div style={{ display: "flex", gap: 8, marginTop: 18, flexWrap: "wrap" }}>
              <Button variant="default" iconLeft="refresh">检查更新</Button>
              <Button variant="outline" iconLeft="github">GitHub 仓库</Button>
              <Button variant="ghost" iconLeft="external">更新日志</Button>
            </div>
          </div>
        </div>

        {/* Quick stats strip */}
        <div style={{
          display: "grid", gridTemplateColumns: "repeat(4, 1fr)",
          marginTop: 24, padding: "16px 0 0", borderTop: "1px solid var(--line)",
          gap: 16,
        }}>
          <Stat2 label="平台支持" value="macOS · Windows" />
          <Stat2 label="许可证" value="PolyForm NC 1.0" />
          <Stat2 label="构建" value="33f7e2a" mono />
          <Stat2 label="技术栈" value="Electron 33 · React 19" />
        </div>
      </div>

      {/* ── Link grid ── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12, marginBottom: 14 }}>
        <LinkCard icon="github" title="项目仓库" url="github.com/QiuYeDx/FusionKit" desc="源码、Issue、Release" tone="var(--fg)" />
        <LinkCard icon="external" title="作者主页" url="qiuvision.com" desc="QiuYeDx · 设计与开发者" tone="var(--t-translator)" />
        <LinkCard icon="fileText" title="作者博客" url="blog.qiuyedx.com" desc="开发笔记与教程" tone="var(--t-converter)" />
        <LinkCard icon="mail" title="联系邮箱" url="me@qiuyedx.com" desc="问题反馈与商务咨询" tone="var(--t-extractor)" />
      </div>

      {/* ── Tech stack ── */}
      <Section title="技术栈与构建信息">
        <div style={{
          display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "10px 28px",
        }}>
          {[
            ["框架",       "Electron 33 + React 19"],
            ["语言",       "TypeScript 5.6"],
            ["构建工具",   "Vite 5"],
            ["样式系统",   "Tailwind CSS 4 + shadcn/ui"],
            ["状态管理",   "Zustand"],
            ["AI 集成",    "Vercel AI SDK"],
            ["国际化",     "i18next"],
            ["包管理器",   "pnpm"],
          ].map(([k, v]) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px dashed var(--line)" }}>
              <span style={{ fontSize: 12.5, color: "var(--mute)" }}>{k}</span>
              <span className="mono" style={{ fontSize: 12.5, color: "var(--fg-2)" }}>{v}</span>
            </div>
          ))}
        </div>

        <div style={{
          marginTop: 16, padding: 12, borderRadius: 10,
          background: "var(--bg-subtle)", border: "1px dashed var(--line)",
          fontSize: 11.5, color: "var(--mute)", display: "flex", alignItems: "center", gap: 10,
        }}>
          <Icon name="info" size={14} />
          本项目采用
          <span className="mono" style={{ color: "var(--fg-2)" }}>PolyForm Noncommercial License 1.0.0</span>
          发布,仅允许非商业使用。
        </div>
      </Section>
    </div>
  );
}

function Stat2({ label, value, mono }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, color: "var(--mute)", textTransform: "uppercase", letterSpacing: "0.07em", fontWeight: 500 }}>
        {label}
      </div>
      <div style={{
        marginTop: 4, fontSize: 13, fontWeight: 500, color: "var(--fg)",
        fontFamily: mono ? "var(--font-mono)" : "inherit",
      }}>{value}</div>
    </div>
  );
}

function LinkCard({ icon, title, url, desc, tone }) {
  return (
    <a href="#" onClick={(e) => e.preventDefault()}
      style={{
        display: "flex", alignItems: "center", gap: 14,
        background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12,
        padding: "14px 16px", textDecoration: "none",
        transition: "all .15s ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "color-mix(in oklch, " + tone + " 35%, var(--line))";
        e.currentTarget.style.background = "color-mix(in oklch, " + tone + " 4%, var(--card))";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "var(--line)";
        e.currentTarget.style.background = "var(--card)";
      }}
    >
      <div style={{
        width: 36, height: 36, borderRadius: 10,
        background: `color-mix(in oklch, ${tone} 12%, transparent)`,
        color: tone, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
      }}>
        <Icon name={icon} size={17} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--fg)" }}>{title}</div>
        <div className="mono" style={{ fontSize: 11.5, color: "var(--mute)", marginTop: 2 }}>{url}</div>
      </div>
      <Icon name="external" size={14} style={{ color: "var(--mute)", flexShrink: 0 }} />
    </a>
  );
}

window.AboutScreen = AboutScreen;
