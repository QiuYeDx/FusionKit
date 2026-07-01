/* Subtitle Translator — Tool Detail page redesign
 * Left: sticky config rail (collapsed groups, compact)
 * Right: drop zone + task queue + summary
 */

function TranslatorScreen({ onBack }) {
  const [sliceMode, setSliceMode] = React.useState("normal");
  const [sourceLang, setSourceLang] = React.useState("JA");
  const [targetLang, setTargetLang] = React.useState("ZH");
  const [outputMode, setOutputMode] = React.useState("bilingual");
  const [outputPath, setOutputPath] = React.useState("custom");
  const [conflict, setConflict] = React.useState("index");
  const [concurrent, setConcurrent] = React.useState(true);
  const [scheduleOpen, setScheduleOpen] = React.useState(false);

  // Demo task data
  const tasks = [
    { name: "EP01_オープニング.srt", status: "resolved", progress: 100, tokens: 4280, cost: 0.012, tone: "green",
      sourceLang: "JA", targetLang: "ZH", mode: "bilingual" },
    { name: "EP02_本編.srt", status: "pending", progress: 64, tokens: 18420, cost: 0.061, tone: "amber",
      sourceLang: "JA", targetLang: "ZH", mode: "bilingual" },
    { name: "EP03_対談パート.srt", status: "waiting", progress: 0, tokens: 12060, cost: 0.034, tone: "blue",
      sourceLang: "JA", targetLang: "ZH", mode: "bilingual" },
    { name: "EP04_predict.lrc",     status: "failed",  progress: 24, tokens: 5210, cost: 0.014, tone: "red",
      sourceLang: "EN", targetLang: "ZH", mode: "target_only", err: "API rate limit exceeded (429)" },
    { name: "EP05_ending_theme.lrc", status: "not_started", progress: 0, tokens: 2120, cost: 0.006, tone: "neutral",
      sourceLang: "EN", targetLang: "ZH", mode: "bilingual" },
  ];

  return (
    <div style={{ padding: "24px 36px 120px", maxWidth: 1280, margin: "0 auto" }}>
      {/* Breadcrumb + title row */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <button
          onClick={onBack}
          style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            padding: "5px 10px 5px 8px", borderRadius: 8,
            background: "transparent", border: "1px solid var(--line)",
            color: "var(--fg-2)", cursor: "pointer", fontSize: 12.5, fontFamily: "inherit",
          }}
        >
          <Icon name="chevLeft" size={14} />
          工具
        </button>
        <Icon name="chevRight" size={13} style={{ color: "var(--mute-2)" }} />
        <span style={{ fontSize: 12.5, color: "var(--mute)" }}>字幕工具箱</span>
        <Icon name="chevRight" size={13} style={{ color: "var(--mute-2)" }} />
        <span style={{ fontSize: 12.5, color: "var(--fg)" }}>字幕翻译</span>
      </div>

      <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 22 }}>
        <ToolBadge tone="var(--t-translator)" icon="languages" size={44} />
        <div style={{ flex: 1 }}>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600, letterSpacing: "-0.02em" }}>字幕翻译</h1>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--mute)" }}>
            调用 AI 大模型对 LRC / SRT 字幕进行高质量翻译,支持双语对照与分片并发。
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Tag tone="green">
            <span style={{
              width: 6, height: 6, borderRadius: "50%", background: "var(--green)",
              boxShadow: "0 0 0 3px color-mix(in oklch, var(--green) 20%, transparent)",
            }} />
            DeepSeek · deepseek-chat
          </Tag>
          <IconBtn icon="settings" variant="outline" />
        </div>
      </div>

      {/* Two-column layout */}
      <div style={{
        display: "grid", gridTemplateColumns: "minmax(0, 320px) 1fr", gap: 16,
        alignItems: "flex-start",
      }}>
        {/* ── LEFT RAIL ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12, position: "sticky", top: 60 }}>
          <ConfigRail
            {...{ sliceMode, setSliceMode, sourceLang, setSourceLang, targetLang, setTargetLang,
                  outputMode, setOutputMode, outputPath, setOutputPath, conflict, setConflict,
                  concurrent, setConcurrent, scheduleOpen, setScheduleOpen }}
          />
        </div>

        {/* ── RIGHT MAIN ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          <DropZone />
          <TaskQueue tasks={tasks} />
          <SummaryBar tasks={tasks} />
        </div>
      </div>
    </div>
  );
}

// ── Config rail (left, sticky) ──────────────────────────
function ConfigRail(p) {
  const langs = [
    { code: "ZH", label: "简体中文" }, { code: "JA", label: "日本語" }, { code: "EN", label: "English" },
    { code: "KO", label: "한국어" }, { code: "FR", label: "Français" }, { code: "DE", label: "Deutsch" },
    { code: "ES", label: "Español" }, { code: "RU", label: "Русский" }, { code: "PT", label: "Português" },
  ];

  return (
    <div style={{
      background: "var(--card)", border: "1px solid var(--line)", borderRadius: 14,
      overflow: "hidden",
    }}>
      <header style={{
        padding: "12px 16px", display: "flex", alignItems: "center", gap: 8,
        background: "var(--bg-subtle)",
      }}>
        <Icon name="settings" size={14} style={{ color: "var(--mute)" }} />
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--fg-2)",
                       textTransform: "uppercase", letterSpacing: "0.06em" }}>
          翻译配置
        </span>
      </header>
      <Divider />

      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
        {/* Language pair */}
        <div>
          <div style={{ fontSize: 11.5, color: "var(--mute)", fontWeight: 500, marginBottom: 6 }}>
            源语言 → 目标语言
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "center", gap: 6 }}>
            <LangSelect value={p.sourceLang} onChange={p.setSourceLang} options={langs} />
            <Icon name="arrowRight" size={14} style={{ color: "var(--mute)" }} />
            <LangSelect value={p.targetLang} onChange={p.setTargetLang}
                        options={langs.filter(l => l.code !== p.sourceLang)} />
          </div>
        </div>

        {/* Output mode */}
        <div>
          <div style={{ fontSize: 11.5, color: "var(--mute)", fontWeight: 500, marginBottom: 6 }}>输出模式</div>
          <Segmented
            value={p.outputMode} onChange={p.setOutputMode}
            options={[
              { value: "bilingual", label: "双语对照" },
              { value: "target_only", label: "仅译文" },
            ]}
          />
        </div>

        {/* Slice */}
        <div>
          <div style={{ fontSize: 11.5, color: "var(--mute)", fontWeight: 500, marginBottom: 6 }}>分片策略</div>
          <Segmented
            value={p.sliceMode} onChange={p.setSliceMode}
            options={[
              { value: "normal", label: "普通" },
              { value: "sensitive", label: "敏感" },
              { value: "custom", label: "自定义" },
            ]}
          />
          {p.sliceMode === "custom" && (
            <div style={{ marginTop: 8 }}>
              <Input size="sm" value="500" mono style={{ width: 100 }} />
              <span style={{ fontSize: 11, color: "var(--mute)", marginLeft: 6 }}>字 / 片</span>
            </div>
          )}
        </div>

        <Divider />

        {/* Output path */}
        <div>
          <div style={{ fontSize: 11.5, color: "var(--mute)", fontWeight: 500, marginBottom: 6 }}>输出路径</div>
          <Segmented
            value={p.outputPath} onChange={p.setOutputPath}
            options={[
              { value: "custom", label: "自定义" },
              { value: "source", label: "源目录" },
            ]}
          />
          {p.outputPath === "custom" && (
            <div style={{
              marginTop: 8, padding: "8px 10px", border: "1px solid var(--line)", borderRadius: 8,
              display: "flex", alignItems: "center", gap: 8, background: "var(--bg-subtle)",
            }}>
              <Icon name="folder" size={13} style={{ color: "var(--mute)" }} />
              <span style={{
                fontSize: 11.5, color: "var(--fg-2)", fontFamily: "var(--font-mono)",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1,
              }}>~/Documents/字幕翻译输出</span>
              <button style={{
                fontSize: 11, color: "var(--acc)", fontWeight: 500,
                background: "transparent", border: "none", cursor: "pointer", fontFamily: "inherit",
              }}>更改</button>
            </div>
          )}
        </div>

        {/* Conflict */}
        <div>
          <div style={{ fontSize: 11.5, color: "var(--mute)", fontWeight: 500, marginBottom: 6 }}>重名策略</div>
          <Segmented
            value={p.conflict} onChange={p.setConflict}
            options={[
              { value: "index", label: "自动编号" },
              { value: "overwrite", label: "覆盖" },
            ]}
          />
        </div>

        <Divider />

        {/* Concurrent */}
        <label style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: 10, borderRadius: 10, gap: 10,
          background: p.concurrent ? "var(--acc-soft)" : "transparent",
          border: "1px solid " + (p.concurrent ? "var(--acc-line)" : "var(--line)"),
          cursor: "pointer",
        }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--fg)" }}>分片并发</span>
            <span style={{ fontSize: 11, color: "var(--mute)" }}>最多 5 路并发</span>
          </div>
          <Toggle checked={p.concurrent} onChange={p.setConcurrent} />
        </label>

        {/* Schedule */}
        <button
          onClick={() => p.setScheduleOpen(o => !o)}
          style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: 10, borderRadius: 10, gap: 10, width: "100%",
            background: "transparent", border: "1px dashed var(--line-strong)",
            cursor: "pointer", fontFamily: "inherit",
          }}>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Icon name="clock" size={13} style={{ color: "var(--mute)" }} />
            <span style={{ fontSize: 12.5, color: "var(--fg-2)" }}>定时开始</span>
          </span>
          <Icon name="chevDown" size={13} style={{
            color: "var(--mute)",
            transform: p.scheduleOpen ? "rotate(180deg)" : "rotate(0)",
            transition: "transform .15s ease",
          }} />
        </button>
        {p.scheduleOpen && (
          <div style={{ padding: 10, background: "var(--bg-subtle)", borderRadius: 8, fontSize: 11.5, color: "var(--mute)" }}>
            选择具体日期与时间,到点后自动开始队列。<br />
            <span style={{ color: "var(--fg-2)" }}>未启用</span>
          </div>
        )}
      </div>
    </div>
  );
}

function LangSelect({ value, onChange, options }) {
  const cur = options.find(o => o.code === value) || options[0];
  return (
    <select
      value={value} onChange={(e) => onChange(e.target.value)}
      style={{
        height: 30, padding: "0 8px", borderRadius: 8, fontSize: 12.5,
        background: "var(--card)", border: "1px solid var(--line-strong)",
        color: "var(--fg)", appearance: "none", cursor: "pointer", fontFamily: "inherit",
        backgroundImage: "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2'><path d='M6 9l6 6 6-6'/></svg>\")",
        backgroundRepeat: "no-repeat", backgroundPosition: "right 8px center", paddingRight: 24,
      }}>
      {options.map(o => <option key={o.code} value={o.code}>{o.label}</option>)}
    </select>
  );
}

// ── Drop zone ──────────────────────────────────────────
function DropZone() {
  const [hover, setHover] = React.useState(false);
  return (
    <div
      onDragEnter={() => setHover(true)}
      onDragLeave={() => setHover(false)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); setHover(false); }}
      style={{
        background: hover ? "var(--acc-soft)" : "var(--card)",
        border: `2px dashed ${hover ? "var(--acc)" : "var(--line-strong)"}`,
        borderRadius: 14, padding: "26px 20px",
        display: "flex", alignItems: "center", gap: 18,
        transition: "all .15s ease",
      }}>
      <div style={{
        width: 48, height: 48, borderRadius: 12,
        background: "var(--bg-subtle)", border: "1px solid var(--line)",
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        color: "var(--fg-2)", flexShrink: 0,
      }}>
        <Icon name={hover ? "folder" : "upload"} size={22} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--fg)" }}>
          {hover ? "释放以添加字幕文件" : "拖拽字幕文件到此处,或点击选择"}
        </div>
        <div style={{ fontSize: 12, color: "var(--mute)", marginTop: 2 }}>
          支持 <code style={{ fontFamily: "var(--font-mono)" }}>.lrc</code> 与
          <code style={{ fontFamily: "var(--font-mono)" }}> .srt</code> · 可批量上传
        </div>
      </div>
      <Button variant="outline" iconLeft="folder">选择文件</Button>
    </div>
  );
}

// ── Task queue ─────────────────────────────────────────
function TaskQueue({ tasks }) {
  const groups = [
    { key: "running", title: "运行中", filter: t => t.status === "pending" || t.status === "waiting" },
    { key: "queued", title: "未开始", filter: t => t.status === "not_started" },
    { key: "done", title: "已完成", filter: t => t.status === "resolved" },
    { key: "failed", title: "失败", filter: t => t.status === "failed" },
  ];

  const statusLabel = {
    pending: "翻译中", waiting: "等待中", not_started: "未开始",
    resolved: "已完成", failed: "失败",
  };
  const statusTone = {
    pending: "amber", waiting: "blue", not_started: "neutral",
    resolved: "green", failed: "red",
  };

  return (
    <div style={{
      background: "var(--card)", border: "1px solid var(--line)", borderRadius: 14,
      overflow: "hidden",
    }}>
      {/* Queue header */}
      <header style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "12px 16px", gap: 12,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--fg)" }}>任务队列</span>
          <Tag tone="neutral" mono>{tasks.length}</Tag>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <Button variant="outline" size="sm" iconLeft="trash">清空已完成</Button>
          <Button variant="default" size="sm" iconLeft="play">全部开始</Button>
        </div>
      </header>
      <Divider />

      {/* Task list */}
      <div>
        {tasks.map((t, i) => (
          <React.Fragment key={t.name}>
            {i > 0 && <Divider />}
            <TaskRow task={t} statusLabel={statusLabel[t.status]} statusTone={statusTone[t.status]} />
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

function TaskRow({ task, statusLabel, statusTone }) {
  return (
    <div style={{ padding: "12px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {/* status indicator */}
        <div style={{ flexShrink: 0 }}>
          {task.status === "resolved" ? (
            <div style={{
              width: 24, height: 24, borderRadius: "50%", background: "var(--green-soft)",
              color: "var(--green)", display: "inline-flex", alignItems: "center", justifyContent: "center",
            }}><Icon name="check" size={14} /></div>
          ) : task.status === "failed" ? (
            <div style={{
              width: 24, height: 24, borderRadius: "50%", background: "var(--red-soft)",
              color: "var(--red)", display: "inline-flex", alignItems: "center", justifyContent: "center",
            }}><Icon name="x" size={13} /></div>
          ) : task.status === "pending" ? (
            <div style={{
              width: 24, height: 24, borderRadius: "50%", background: "var(--amber-soft)",
              color: "var(--amber)", display: "inline-flex", alignItems: "center", justifyContent: "center",
              animation: "fk-pulse 1.6s ease-in-out infinite",
            }}><Icon name="zap" size={13} /></div>
          ) : (
            <div style={{
              width: 24, height: 24, borderRadius: "50%", background: "var(--bg-subtle)",
              border: "1px dashed var(--line-strong)",
              color: "var(--mute)", display: "inline-flex", alignItems: "center", justifyContent: "center",
              fontSize: 10, fontWeight: 600,
            }}>·</div>
          )}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{
              fontSize: 13, fontWeight: 500, color: "var(--fg)",
              fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>{task.name}</span>
            <Tag tone={statusTone}>{statusLabel}</Tag>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 4, fontSize: 11.5, color: "var(--mute)" }}>
            <span>{task.sourceLang} → {task.targetLang}</span>
            <span style={{ width: 3, height: 3, borderRadius: "50%", background: "var(--line-strong)" }} />
            <span>{task.mode === "bilingual" ? "双语对照" : "仅译文"}</span>
            <span style={{ width: 3, height: 3, borderRadius: "50%", background: "var(--line-strong)" }} />
            <span className="mono">{task.tokens.toLocaleString()} tokens</span>
            <span style={{ width: 3, height: 3, borderRadius: "50%", background: "var(--line-strong)" }} />
            <span className="mono">${task.cost.toFixed(3)}</span>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
          {task.status === "failed" && <IconBtn icon="refresh" title="重试" />}
          {(task.status === "resolved" || task.status === "failed") && <IconBtn icon="folder" title="打开位置" />}
          {task.status === "not_started" && <IconBtn icon="play" title="开始" />}
          {(task.status === "pending" || task.status === "waiting") && <IconBtn icon="x" title="取消" />}
          <IconBtn icon="edit" title="编辑配置" />
          <IconBtn icon="trash" title="删除" />
        </div>
      </div>

      {/* Progress / error */}
      {task.status === "pending" && (
        <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10 }}>
          <Progress value={task.progress} tone="amber" height={3} />
          <span className="mono" style={{ fontSize: 11, color: "var(--mute)", flexShrink: 0, width: 36 }}>
            {task.progress}%
          </span>
        </div>
      )}
      {task.status === "failed" && (
        <div style={{
          marginTop: 8, padding: "6px 10px", borderRadius: 8,
          background: "var(--red-soft)", color: "var(--red)",
          fontSize: 11.5, display: "flex", alignItems: "center", gap: 6,
        }}>
          <Icon name="info" size={12} />
          {task.err}
        </div>
      )}
    </div>
  );
}

// ── Summary bar ────────────────────────────────────────
function SummaryBar({ tasks }) {
  const total = tasks.reduce((a, t) => a + t.tokens, 0);
  const cost  = tasks.reduce((a, t) => a + t.cost, 0);
  const pending = tasks.filter(t => t.status === "pending" || t.status === "waiting" || t.status === "not_started")
                       .reduce((a, t) => a + t.cost, 0);
  return (
    <div style={{
      background: "var(--card)", border: "1px solid var(--line)", borderRadius: 14,
      padding: "14px 18px", display: "grid",
      gridTemplateColumns: "repeat(4, 1fr)", gap: 20, alignItems: "center",
    }}>
      <Stat label="任务总数" value={tasks.length} suffix="" />
      <Stat label="总 Token" value={total.toLocaleString()} suffix="tokens" />
      <Stat label="预估总成本" value={`$${cost.toFixed(3)}`} accent />
      <Stat label="待执行成本" value={`$${pending.toFixed(3)}`} />
    </div>
  );
}

function Stat({ label, value, suffix, accent }) {
  return (
    <div>
      <div style={{ fontSize: 11.5, color: "var(--mute)", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 500 }}>
        {label}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 4 }}>
        <span className="mono" style={{
          fontSize: 18, fontWeight: 600,
          color: accent ? "var(--acc)" : "var(--fg)",
          letterSpacing: "-0.02em",
        }}>{value}</span>
        {suffix && <span style={{ fontSize: 11, color: "var(--mute)" }}>{suffix}</span>}
      </div>
    </div>
  );
}

window.TranslatorScreen = TranslatorScreen;
