/* Settings — sidebar SubNav (General / Proxy / Model / Notifications)
 * Tweak: "tabs" (sidebar layout) or "long" (single column)
 */

function SettingsScreen({ layout = "tabs" }) {
  const [tab, setTab] = React.useState("general");
  const sections = [
    { key: "general",  label: "常规",     icon: "settings", hint: "外观、语言、通知" },
    { key: "proxy",    label: "网络代理", icon: "globe",    hint: "无代理 / 系统 / 自定义" },
    { key: "model",    label: "AI 模型",  icon: "cpu",      hint: "字幕翻译 · AI 助手" },
    { key: "advanced", label: "高级选项", icon: "shield",   hint: "防休眠 · 数据 · 实验性" },
  ];

  if (layout === "long") {
    return (
      <div style={{ padding: "32px 36px 120px", maxWidth: 900, margin: "0 auto" }}>
        <PageHeader title="设置" subtitle="配置 FusionKit 的外观、网络与 AI 模型参数。" />
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <GeneralSection />
          <ProxySection />
          <ModelSection />
          <AdvancedSection />
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: "32px 36px 120px", maxWidth: 1100, margin: "0 auto" }}>
      <PageHeader title="设置" subtitle="配置 FusionKit 的外观、网络与 AI 模型参数。" />

      <div style={{
        display: "grid", gridTemplateColumns: "220px 1fr", gap: 18,
        alignItems: "flex-start",
      }}>
        {/* Sub-nav rail */}
        <nav style={{
          position: "sticky", top: 60, display: "flex", flexDirection: "column", gap: 2,
        }}>
          {sections.map((s) => {
            const active = s.key === tab;
            return (
              <button
                key={s.key} onClick={() => setTab(s.key)}
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "10px 12px", borderRadius: 10,
                  background: active ? "var(--acc-soft)" : "transparent",
                  border: "1px solid " + (active ? "var(--acc-line)" : "transparent"),
                  color: active ? "var(--acc)" : "var(--fg-2)",
                  cursor: "pointer", fontFamily: "inherit", textAlign: "left",
                  transition: "background .12s",
                }}
                onMouseEnter={(e) => !active && (e.currentTarget.style.background = "var(--bg-subtle)")}
                onMouseLeave={(e) => !active && (e.currentTarget.style.background = "transparent")}
              >
                <Icon name={s.icon} size={15} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{s.label}</div>
                  <div style={{ fontSize: 11, color: active ? "var(--acc)" : "var(--mute)", marginTop: 1, fontWeight: 400, opacity: active ? 0.75 : 1 }}>
                    {s.hint}
                  </div>
                </div>
              </button>
            );
          })}
        </nav>

        {/* Panel */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
          {tab === "general"  && <GeneralSection />}
          {tab === "proxy"    && <ProxySection />}
          {tab === "model"    && <ModelSection />}
          {tab === "advanced" && <AdvancedSection />}
        </div>
      </div>
    </div>
  );
}

// ─────────────── General ───────────────
function GeneralSection() {
  const [theme, setTheme] = React.useState("system");
  const [lang, setLang] = React.useState("zh");
  const [notify, setNotify] = React.useState(true);
  const [sound, setSound] = React.useState(false);

  return (
    <Section title="常规" hint="外观、语言、通知与基础行为。">
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Field label="界面语言">
          <Segmented value={lang} onChange={setLang} options={[
            { value: "zh", label: "简体中文" },
            { value: "ja", label: "日本語" },
            { value: "en", label: "English" },
          ]} />
        </Field>
        <Divider />

        <Field label="主题外观">
          <Segmented value={theme} onChange={setTheme} options={[
            { value: "light",  label: "浅色", icon: "sun" },
            { value: "dark",   label: "深色", icon: "moon" },
            { value: "system", label: "跟随系统" },
          ]} />
        </Field>
        <Divider />

        <Field label="系统通知" hint="任务完成 / 失败时发送系统通知">
          <Toggle checked={notify} onChange={setNotify} />
          <span style={{ fontSize: 12, color: "var(--mute)" }}>
            {notify ? "已开启" : "已关闭"}
          </span>
          <Button variant="outline" size="sm" iconLeft="bell">发送测试通知</Button>
        </Field>
        <Divider />

        <Field label="完成提示音">
          <Toggle checked={sound} onChange={setSound} />
          <span style={{ fontSize: 12, color: "var(--mute)" }}>
            {sound ? "已开启" : "已关闭"}
          </span>
        </Field>
      </div>
    </Section>
  );
}

// ─────────────── Proxy ────────────────
function ProxySection() {
  const [mode, setMode] = React.useState("system");
  const [protocol, setProtocol] = React.useState("http");

  return (
    <Section title="网络代理" hint="为 API 请求与下载更新配置网络代理。">
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Field label="代理模式">
          <Segmented value={mode} onChange={setMode} options={[
            { value: "none",   label: "不使用" },
            { value: "system", label: "系统代理" },
            { value: "custom", label: "自定义" },
          ]} />
        </Field>

        {mode === "custom" && (
          <>
            <Divider />
            <Field label="代理协议">
              <Segmented value={protocol} onChange={setProtocol} options={[
                { value: "http",   label: "HTTP" },
                { value: "https",  label: "HTTPS" },
                { value: "socks5", label: "SOCKS5" },
              ]} />
            </Field>
            <Field label="主机 / 端口">
              <Input value="127.0.0.1" mono style={{ flex: 1 }} />
              <Input value="7890" mono style={{ width: 80 }} />
            </Field>
            <Field label="鉴权" hint="可选">
              <Input value="" placeholder="用户名" style={{ flex: 1 }} />
              <Input value="" placeholder="密码" type="password" style={{ flex: 1 }} />
            </Field>
            <Field label="">
              <Button variant="outline" size="sm" iconLeft="globe">测试连接</Button>
              <Button variant="soft" size="sm" iconLeft="check">应用并保存</Button>
            </Field>
          </>
        )}

        {mode === "system" && (
          <div style={{
            padding: 12, background: "var(--bg-subtle)", borderRadius: 10,
            fontSize: 12, color: "var(--mute)",
            display: "flex", alignItems: "center", gap: 8,
          }}>
            <Icon name="info" size={14} />
            将使用操作系统的代理设置。当前已检测到: <code className="mono" style={{ color: "var(--fg-2)" }}>http://127.0.0.1:7890</code>
          </div>
        )}
      </div>
    </Section>
  );
}

// ─────────────── Model ────────────────
function ModelSection() {
  const [profile, setProfile] = React.useState("translator");
  const [preset, setPreset] = React.useState("deepseek");
  return (
    <Section
      title="AI 模型"
      hint="为字幕翻译与 AI 助手分别配置 OpenAI 兼容的模型参数。"
      right={
        <Segmented value={profile} onChange={setProfile} options={[
          { value: "translator", label: "字幕翻译" },
          { value: "assistant",  label: "AI 助手" },
        ]} />
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {/* preset chooser */}
        <div>
          <div style={{ fontSize: 12, color: "var(--mute)", marginBottom: 8, fontWeight: 500 }}>
            服务预设
          </div>
          <div style={{
            display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8,
          }}>
            {[
              { id: "deepseek", label: "DeepSeek", sub: "deepseek-chat", price: "$0.27 / $1.10" },
              { id: "openai",   label: "OpenAI",   sub: "gpt-4o-mini",   price: "$0.15 / $0.60" },
              { id: "custom",   label: "自定义",   sub: "OpenAI 兼容",   price: "—" },
            ].map((p) => {
              const sel = preset === p.id;
              return (
                <button key={p.id} onClick={() => setPreset(p.id)}
                  style={{
                    padding: 12, borderRadius: 12, textAlign: "left",
                    background: sel ? "var(--acc-soft)" : "var(--card)",
                    border: "1px solid " + (sel ? "var(--acc-line)" : "var(--line)"),
                    cursor: "pointer", fontFamily: "inherit",
                    transition: "all .15s",
                  }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: sel ? "var(--acc)" : "var(--fg)" }}>
                      {p.label}
                    </span>
                    {sel && <Icon name="check" size={14} style={{ color: "var(--acc)" }} />}
                  </div>
                  <div className="mono" style={{ fontSize: 11, color: "var(--mute)", marginTop: 4 }}>{p.sub}</div>
                  <div className="mono" style={{ fontSize: 10.5, color: "var(--mute-2)", marginTop: 6 }}>
                    {p.price} / 1M
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <Divider />

        {/* Config fields */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Field label="API Endpoint">
            <Input mono value="https://api.deepseek.com/v1" style={{ flex: 1 }} />
          </Field>
          <Field label="API Key">
            <Input mono type="password" value="sk-••••••••••••••••••••••••••" style={{ flex: 1 }} />
            <IconBtn icon="refresh" title="测试连接" variant="outline" />
          </Field>
          <Field label="模型">
            <Input mono value="deepseek-chat" style={{ flex: 1 }} />
          </Field>

          <Divider />

          <div style={{
            display: "grid", gridTemplateColumns: "112px 1fr 1fr", gap: 12, alignItems: "center",
          }}>
            <label style={{ fontSize: 12.5, color: "var(--fg-2)", fontWeight: 500 }}>Token 价格</label>
            <div>
              <div style={{ fontSize: 11, color: "var(--mute)", marginBottom: 4 }}>输入 ($/1M)</div>
              <Input mono value="0.27" />
            </div>
            <div>
              <div style={{ fontSize: 11, color: "var(--mute)", marginBottom: 4 }}>输出 ($/1M)</div>
              <Input mono value="1.10" />
            </div>
          </div>
        </div>

        <Divider />

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 11.5, color: "var(--mute)" }}>
            最近一次连接测试: <span className="mono" style={{ color: "var(--green)" }}>200 OK · 412ms</span>
          </span>
          <div style={{ display: "flex", gap: 6 }}>
            <Button variant="outline" size="sm">恢复默认</Button>
            <Button variant="default" size="sm" iconLeft="check">保存配置</Button>
          </div>
        </div>
      </div>
    </Section>
  );
}

// ─────────────── Advanced ───────────────
function AdvancedSection() {
  const [block, setBlock] = React.useState(true);
  const [auto, setAuto] = React.useState(true);
  return (
    <>
      <Section title="任务执行" hint="长任务期间的系统行为">
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Field label="防止系统休眠" hint="翻译期间阻止系统进入睡眠">
            <Toggle checked={block} onChange={setBlock} />
          </Field>
          <Divider />
          <Field label="自动开始排队" hint="新任务添加后自动加入运行队列">
            <Toggle checked={auto} onChange={setAuto} />
          </Field>
        </div>
      </Section>

      <Section title="数据与缓存" hint="本地存储与历史记录">
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Field label="会话历史">
            <span className="mono" style={{ fontSize: 12.5, color: "var(--fg-2)" }}>42 个会话 · 3.2 MB</span>
            <Button variant="outline" size="sm">导出全部</Button>
            <Button variant="danger" size="sm">清空</Button>
          </Field>
          <Divider />
          <Field label="估算缓存">
            <span className="mono" style={{ fontSize: 12.5, color: "var(--fg-2)" }}>118 KB</span>
            <Button variant="outline" size="sm" iconLeft="trash">清除</Button>
          </Field>
        </div>
      </Section>
    </>
  );
}

window.SettingsScreen = SettingsScreen;
