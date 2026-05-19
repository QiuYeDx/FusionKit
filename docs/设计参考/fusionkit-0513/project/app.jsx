/* App shell — macOS window, title bar, bottom pill nav, tweaks
 */

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "light",
  "accent": "#1f1d1b",
  "toolsLayout": "card",
  "settingsLayout": "tabs"
}/*EDITMODE-END*/;

// hex → accent css key. Bare value means base tokens (graphite).
const ACCENT_MAP = {
  "#1f1d1b": undefined,
  "#e07a3a": "orange",
  "#5b56d6": "indigo",
  "#2a8aa0": "teal",
};

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [route, setRoute] = React.useState("tools");
  const scrollerRef = React.useRef(null);

  // Apply theme + accent to root
  React.useEffect(() => {
    const root = document.querySelector(".fk-app");
    if (!root) return;
    root.setAttribute("data-theme", t.theme);
    if (ACCENT_MAP[t.accent]) root.setAttribute("data-accent", ACCENT_MAP[t.accent]);
    else root.removeAttribute("data-accent");
  }, [t.theme, t.accent]);

  // Reset scroll on route change
  React.useEffect(() => {
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
  }, [route]);

  const isMainMenu = ["home", "tools", "about", "setting"].includes(route);

  return (
    <div style={{
      minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      padding: "32px 24px",
    }}>
      <WindowFrame>
        <div
          className="fk-app"
          data-theme={t.theme}
          style={{
            display: "flex", flexDirection: "column",
            background: "var(--bg)", color: "var(--fg)",
            height: "100%", position: "relative", overflow: "hidden",
          }}
        >
          {/* Floating title pill */}
          <TitleBar />

          {/* Scroll area */}
          <div
            ref={scrollerRef}
            className="fk-scroll"
            style={{
              flex: 1, overflow: "auto", paddingTop: 44,
              scrollBehavior: "smooth",
            }}
          >
            {route === "tools"      && <ToolsScreen layout={t.toolsLayout} onOpen={(id) => setRoute("tool:" + id)} />}
            {route === "tool:translator" && <TranslatorScreen onBack={() => setRoute("tools")} />}
            {route === "tool:converter" && <PlaceholderScreen title="字幕格式转换" onBack={() => setRoute("tools")} icon="refresh" tone="var(--t-converter)" />}
            {route === "tool:extractor" && <PlaceholderScreen title="字幕语言提取" onBack={() => setRoute("tools")} icon="fileText" tone="var(--t-extractor)" />}
            {route === "about"      && <AboutScreen />}
            {route === "setting"    && <SettingsScreen layout={t.settingsLayout} />}
            {route === "home"       && <HomeAgentScreen />}
          </div>

          {/* Floating bottom nav */}
          <BottomNav route={route} setRoute={setRoute} isMainMenu={isMainMenu} theme={t.theme}
                     onToggleTheme={() => setTweak("theme", t.theme === "dark" ? "light" : "dark")} />
        </div>
      </WindowFrame>

      {/* Tweaks Panel */}
      <TweaksPanel title="Tweaks">
        <TweakSection label="主题">
          <TweakRadio
            label="外观"
            value={t.theme} onChange={(v) => setTweak("theme", v)}
            options={[
              { value: "light", label: "浅色" },
              { value: "dark",  label: "深色" },
            ]}
          />
          <TweakColor
            label="主色调"
            value={t.accent} onChange={(v) => setTweak("accent", v)}
            options={["#1f1d1b", "#e07a3a", "#5b56d6", "#2a8aa0"]}
          />
        </TweakSection>

        <TweakSection label="布局">
          <TweakRadio
            label="工具列表"
            value={t.toolsLayout} onChange={(v) => setTweak("toolsLayout", v)}
            options={[
              { value: "card", label: "卡片网格" },
              { value: "list", label: "紧凑列表" },
            ]}
          />
          <TweakRadio
            label="设置页"
            value={t.settingsLayout} onChange={(v) => setTweak("settingsLayout", v)}
            options={[
              { value: "tabs", label: "侧边导航" },
              { value: "long", label: "单列长页" },
            ]}
          />
        </TweakSection>

        <TweakSection label="跳转">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <TweakButton label="工具列表" onClick={() => setRoute("tools")} />
            <TweakButton label="翻译详情" onClick={() => setRoute("tool:translator")} />
            <TweakButton label="设置" onClick={() => setRoute("setting")} />
            <TweakButton label="关于" onClick={() => setRoute("about")} />
          </div>
        </TweakSection>
      </TweaksPanel>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// Window frame (macOS-like)
// ─────────────────────────────────────────────────────────
function WindowFrame({ children }) {
  return (
    <div style={{
      width: "min(1180px, 100%)", height: "min(820px, calc(100vh - 64px))",
      borderRadius: 14, overflow: "hidden",
      boxShadow: "0 0 0 1px rgba(0,0,0,0.18), 0 26px 80px -16px rgba(0,0,0,0.4), 0 6px 18px rgba(0,0,0,0.12)",
      background: "var(--bg)", position: "relative",
    }}>
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// Title bar (floating pill with traffic lights left)
// ─────────────────────────────────────────────────────────
function TitleBar() {
  return (
    <div className="fk-titlebar" style={{
      position: "absolute", top: 0, left: 0, right: 0, height: 40, zIndex: 50,
      display: "flex", alignItems: "center", justifyContent: "center",
      pointerEvents: "none",
    }}>
      {/* Traffic lights */}
      <div style={{
        position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)",
        display: "flex", gap: 8, pointerEvents: "auto",
      }}>
        <span style={{ width: 12, height: 12, borderRadius: "50%", background: "#ff5f57", boxShadow: "inset 0 0 0 0.5px rgba(0,0,0,0.15)" }} />
        <span style={{ width: 12, height: 12, borderRadius: "50%", background: "#febc2e", boxShadow: "inset 0 0 0 0.5px rgba(0,0,0,0.15)" }} />
        <span style={{ width: 12, height: 12, borderRadius: "50%", background: "#28c840", boxShadow: "inset 0 0 0 0.5px rgba(0,0,0,0.15)" }} />
      </div>

      {/* Title pill */}
      <div style={{
        height: 26, padding: "0 14px",
        display: "flex", alignItems: "center", gap: 8,
        background: "color-mix(in oklch, var(--card) 65%, transparent)",
        backdropFilter: "blur(20px) saturate(150%)",
        WebkitBackdropFilter: "blur(20px) saturate(150%)",
        border: "1px solid color-mix(in oklch, var(--line) 60%, transparent)",
        borderRadius: 999,
        fontSize: 11.5, fontFamily: "var(--font-mono)", color: "var(--fg-2)",
        letterSpacing: "0.02em",
      }}>
        <FKLogo size={13} />
        FusionKit
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// Bottom pill navigation
// ─────────────────────────────────────────────────────────
function BottomNav({ route, setRoute, isMainMenu, theme, onToggleTheme }) {
  const items = [
    { key: "home",    icon: "sparkle",  label: "助手" },
    { key: "tools",   icon: "wrench",   label: "工具" },
    { key: "about",   icon: "info",     label: "关于" },
    { key: "setting", icon: "settings", label: "设置" },
  ];

  return (
    <div style={{
      position: "absolute", bottom: 0, left: 0, right: 0, height: 64,
      display: "flex", alignItems: "center", justifyContent: "center",
      pointerEvents: "none", zIndex: 40,
    }}>
      {isMainMenu ? (
        <div style={{
          display: "flex", gap: 2, padding: 4,
          background: "color-mix(in oklch, var(--card) 80%, transparent)",
          backdropFilter: "blur(16px) saturate(180%)",
          WebkitBackdropFilter: "blur(16px) saturate(180%)",
          border: "1px solid var(--line)",
          borderRadius: 999, boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
          pointerEvents: "auto",
        }}>
          {items.map((it) => {
            const sel = it.key === route;
            return (
              <button
                key={it.key} onClick={() => setRoute(it.key)}
                style={{
                  height: 34, padding: "0 14px", borderRadius: 999,
                  display: "inline-flex", alignItems: "center", gap: 6,
                  background: sel ? "var(--acc-soft)" : "transparent",
                  color: sel ? "var(--acc)" : "var(--mute)",
                  border: "none", cursor: "pointer", fontFamily: "inherit",
                  fontSize: 12.5, fontWeight: 500,
                  transition: "all .15s ease",
                }}
              >
                <Icon name={it.icon} size={15} />
                {it.label}
              </button>
            );
          })}
        </div>
      ) : (
        <div style={{
          display: "flex", gap: 2, padding: 4,
          background: "color-mix(in oklch, var(--card) 80%, transparent)",
          backdropFilter: "blur(16px) saturate(180%)",
          WebkitBackdropFilter: "blur(16px) saturate(180%)",
          border: "1px solid var(--line)",
          borderRadius: 999, boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
          pointerEvents: "auto",
        }}>
          <button
            onClick={() => setRoute("tools")}
            style={{
              height: 34, padding: "0 14px", borderRadius: 999,
              display: "inline-flex", alignItems: "center", gap: 6,
              background: "transparent", color: "var(--mute)",
              border: "none", cursor: "pointer", fontFamily: "inherit",
              fontSize: 12.5, fontWeight: 500,
            }}>
            <Icon name="chevLeft" size={15} />
            返回
          </button>
          <button
            style={{
              height: 34, padding: "0 14px", borderRadius: 999,
              display: "inline-flex", alignItems: "center", gap: 6,
              background: "var(--acc-soft)", color: "var(--acc)",
              border: "none", cursor: "pointer", fontFamily: "inherit",
              fontSize: 12.5, fontWeight: 500,
            }}>
            <Icon name="wrench" size={15} />
            当前工具
          </button>
        </div>
      )}

      {/* Theme toggle (right) */}
      <button
        onClick={onToggleTheme}
        style={{
          position: "absolute", right: 20, width: 36, height: 36, borderRadius: "50%",
          background: "color-mix(in oklch, var(--card) 80%, transparent)",
          backdropFilter: "blur(16px) saturate(180%)",
          WebkitBackdropFilter: "blur(16px) saturate(180%)",
          border: "1px solid var(--line)",
          color: "var(--fg-2)", cursor: "pointer",
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          pointerEvents: "auto",
          boxShadow: "0 4px 12px rgba(0,0,0,0.06)",
        }}>
        <Icon name={theme === "dark" ? "moon" : "sun"} size={16} />
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// Placeholder tool screen (for converter / extractor)
// ─────────────────────────────────────────────────────────
function PlaceholderScreen({ title, onBack, icon, tone }) {
  return (
    <div style={{ padding: "24px 36px 120px", maxWidth: 1080, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <button onClick={onBack} style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          padding: "5px 10px 5px 8px", borderRadius: 8,
          background: "transparent", border: "1px solid var(--line)",
          color: "var(--fg-2)", cursor: "pointer", fontSize: 12.5, fontFamily: "inherit",
        }}>
          <Icon name="chevLeft" size={14} />
          工具
        </button>
      </div>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 22 }}>
        <ToolBadge tone={tone} icon={icon} size={44} />
        <div style={{ flex: 1 }}>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600, letterSpacing: "-0.02em" }}>{title}</h1>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--mute)" }}>
            这个工具采用与「字幕翻译」相同的设计语言:左侧配置 + 右侧任务队列。点击下方查看完整原型。
          </p>
        </div>
      </div>
      <Card>
        <div style={{
          padding: "60px 40px", display: "flex", flexDirection: "column",
          alignItems: "center", gap: 16, textAlign: "center",
        }}>
          <ToolBadge tone={tone} icon={icon} size={56} />
          <div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>设计预览</div>
            <div style={{ fontSize: 13, color: "var(--mute)", marginTop: 4, maxWidth: 360 }}>
              此页面沿用「字幕翻译」详情页的双栏结构与控件,根据具体功能调整字段。请打开「字幕翻译」查看完整设计。
            </div>
          </div>
          <Button variant="outline" iconLeft="arrowRight" onClick={onBack}>返回工具列表</Button>
        </div>
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// Home Agent (placeholder hero — not in scope for this redesign)
// ─────────────────────────────────────────────────────────
function HomeAgentScreen() {
  return (
    <div style={{ padding: "60px 36px", maxWidth: 760, margin: "0 auto", textAlign: "center" }}>
      <FKLogo size={56} />
      <h1 style={{ marginTop: 18, fontSize: 24, fontWeight: 600, letterSpacing: "-0.02em" }}>
        FusionKit Assistant
      </h1>
      <p style={{ fontSize: 13.5, color: "var(--mute)", maxWidth: 520, margin: "8px auto 0", lineHeight: 1.6 }}>
        通过自然语言驱动字幕处理。本次重设计聚焦于工具列表、详情、设置与关于页 ——
        点击下方任一入口查看具体页面。
      </p>
      <div style={{ display: "flex", justifyContent: "center", gap: 8, marginTop: 22 }}>
        <Tag tone="outline">不在此次设计范围</Tag>
      </div>
    </div>
  );
}

// Mount
const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);
