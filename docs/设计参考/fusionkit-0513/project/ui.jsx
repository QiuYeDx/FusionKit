/* FusionKit UI Primitives + Icons
 * Shared low-level components. Export to window for cross-file access.
 */

const { useState, useEffect, useRef, useMemo, useCallback } = React;

// ─────────────────────────────────────────────────────────
// Icon set — line, 1.6 stroke, 18px viewbox, scalable
// ─────────────────────────────────────────────────────────
function Icon({ name, size = 16, stroke = 1.6, className = "", style = {} }) {
  const props = {
    width: size, height: size, viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", strokeWidth: stroke,
    strokeLinecap: "round", strokeLinejoin: "round",
    className, style,
  };
  const paths = {
    home:      <><path d="M3 11l9-8 9 8" /><path d="M5 10v10h14V10" /></>,
    wrench:    <><path d="M14.7 6.3a4 4 0 1 0 5 5L21 13l-8 8-6-6 8-8 -.3-.7z" /></>,
    info:      <><circle cx="12" cy="12" r="9" /><path d="M12 8h.01M11 12h1v5h1" /></>,
    settings:  <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>,
    chevDown:  <><path d="M6 9l6 6 6-6" /></>,
    chevRight: <><path d="M9 6l6 6-6 6" /></>,
    chevLeft:  <><path d="M15 6l-6 6 6 6" /></>,
    arrowRight:<><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></>,
    arrowSwap: <><path d="M7 4v16" /><path d="M3 8l4-4 4 4" /><path d="M17 20V4" /><path d="M13 16l4 4 4-4" /></>,
    plus:      <><path d="M12 5v14" /><path d="M5 12h14" /></>,
    upload:    <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M17 8l-5-5-5 5" /><path d="M12 3v12" /></>,
    folder:    <><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" /></>,
    download:  <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5" /><path d="M12 15V3" /></>,
    play:      <><path d="M6 4l14 8-14 8V4z" /></>,
    pause:     <><path d="M6 4h4v16H6zM14 4h4v16h-4z" /></>,
    moon:      <><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></>,
    sun:       <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
    bell:      <><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9z" /><path d="M10 21a2 2 0 0 0 4 0" /></>,
    github:    <><path d="M9 19c-4 1.5-4-2-6-2.5M15 22v-3.4c0-1 .1-1.6-.5-2 3-.3 6-1.6 6-7a5.5 5.5 0 0 0-1.6-3.8 5 5 0 0 0-.1-3.7s-1.2-.3-3.8 1.4a13 13 0 0 0-7 0C5.4 1.5 4.2 1.8 4.2 1.8a5 5 0 0 0-.1 3.7A5.5 5.5 0 0 0 2.5 9.3c0 5.3 3 6.6 6 7-.6.4-.6 1-.5 2V22" /></>,
    mail:      <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></>,
    external:  <><path d="M14 4h6v6" /><path d="M20 4l-9 9" /><path d="M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6" /></>,
    sparkle:   <><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" /></>,
    bot:       <><rect x="3" y="8" width="18" height="12" rx="3" /><path d="M12 2v3" /><circle cx="8.5" cy="14" r="1" fill="currentColor" stroke="none" /><circle cx="15.5" cy="14" r="1" fill="currentColor" stroke="none" /></>,
    languages: <><path d="M5 8h14" /><path d="M11 4v4" /><path d="M9 8c0 5-4 8-6 8" /><path d="M5 12c0 2 2.5 4 6 5" /><path d="M13 21l4-9 4 9" /><path d="M14.5 17h5" /></>,
    fileText:  <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M8 13h8M8 17h6M8 9h2" /></>,
    music:     <><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></>,
    edit:      <><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.1 2.1 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></>,
    trash:     <><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14" /></>,
    refresh:   <><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></>,
    check:     <><path d="M5 13l4 4L19 7" /></>,
    x:         <><path d="M6 6l12 12M18 6L6 18" /></>,
    cpu:       <><rect x="5" y="5" width="14" height="14" rx="2" /><rect x="9" y="9" width="6" height="6" /><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" /></>,
    clock:     <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    globe:     <><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z" /></>,
    shield:    <><path d="M12 2l8 4v6c0 5-4 9-8 10-4-1-8-5-8-10V6l8-4z" /></>,
    palette:   <><path d="M12 2a10 10 0 1 0 0 20c1 0 2-1 2-2 0-1 0-2 1-2h2a4 4 0 0 0 0-8h-1" /><circle cx="7.5" cy="10" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="7" r="1" fill="currentColor" stroke="none" /><circle cx="16.5" cy="10" r="1" fill="currentColor" stroke="none" /></>,
    grid:      <><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></>,
    list:      <><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></>,
    lock:      <><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>,
    zap:       <><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" /></>,
  };
  return <svg {...props}>{paths[name] || null}</svg>;
}

// ─────────────────────────────────────────────────────────
// Surface helpers
// ─────────────────────────────────────────────────────────
function Card({ children, padded = true, style = {}, className = "", ...rest }) {
  return (
    <div
      className={className}
      style={{
        background: "var(--card)",
        border: "1px solid var(--line)",
        borderRadius: 14,
        padding: padded ? 16 : 0,
        ...style,
      }}
      {...rest}
    >
      {children}
    </div>
  );
}

function Divider({ vertical, style = {} }) {
  return (
    <div style={{
      background: "var(--line)",
      flexShrink: 0,
      ...(vertical
        ? { width: 1, alignSelf: "stretch" }
        : { height: 1, width: "100%" }),
      ...style,
    }} />
  );
}

// SectionHeader — uniform page header
function PageHeader({ title, subtitle, right }) {
  return (
    <div style={{
      display: "flex", alignItems: "flex-end", justifyContent: "space-between",
      gap: 24, marginBottom: 20,
    }}>
      <div>
        <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em", color: "var(--fg)" }}>{title}</div>
        {subtitle && (
          <div style={{ fontSize: 13, color: "var(--mute)", marginTop: 4, maxWidth: 560 }}>
            {subtitle}
          </div>
        )}
      </div>
      {right}
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// Buttons
// ─────────────────────────────────────────────────────────
function Button({
  children, variant = "default", size = "md", iconLeft, iconRight,
  disabled, onClick, style = {}, type = "button", title,
}) {
  const sizes = {
    sm: { h: 28, px: 10, fz: 12, gap: 6, ico: 13 },
    md: { h: 34, px: 13, fz: 13, gap: 7, ico: 14 },
    lg: { h: 40, px: 16, fz: 14, gap: 8, ico: 16 },
  };
  const s = sizes[size];
  const variants = {
    default: {
      background: "var(--acc)", color: "var(--acc-ink)",
      border: "1px solid var(--acc)",
    },
    outline: {
      background: "transparent", color: "var(--fg)",
      border: "1px solid var(--line-strong)",
    },
    ghost: {
      background: "transparent", color: "var(--fg-2)",
      border: "1px solid transparent",
    },
    soft: {
      background: "var(--acc-soft)", color: "var(--acc)",
      border: "1px solid transparent",
    },
    danger: {
      background: "transparent", color: "var(--red)",
      border: "1px solid var(--line-strong)",
    },
  };
  return (
    <button
      type={type}
      title={title}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        height: s.h, padding: `0 ${s.px}px`, gap: s.gap, fontSize: s.fz,
        borderRadius: 999, fontWeight: 500, fontFamily: "inherit",
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1,
        whiteSpace: "nowrap", transition: "all .15s ease",
        ...variants[variant], ...style,
      }}
    >
      {iconLeft && <Icon name={iconLeft} size={s.ico} />}
      {children}
      {iconRight && <Icon name={iconRight} size={s.ico} />}
    </button>
  );
}

// IconBtn — square, icon-only
function IconBtn({ icon, onClick, title, active, size = 32, variant = "ghost" }) {
  const v = variant === "ghost"
    ? { background: active ? "var(--acc-soft)" : "transparent", color: active ? "var(--acc)" : "var(--fg-2)", border: "1px solid transparent" }
    : { background: "var(--card)", color: "var(--fg-2)", border: "1px solid var(--line)" };
  return (
    <button
      onClick={onClick} title={title}
      style={{
        width: size, height: size, borderRadius: 8, display: "inline-flex",
        alignItems: "center", justifyContent: "center", cursor: "pointer",
        transition: "all .15s ease", flexShrink: 0,
        ...v,
      }}
    >
      <Icon name={icon} size={Math.round(size * 0.5)} />
    </button>
  );
}

// Segmented control — for theme/lang/binary picks
function Segmented({ options, value, onChange, size = "md" }) {
  const h = size === "sm" ? 28 : 32;
  return (
    <div style={{
      display: "inline-flex", padding: 3, background: "var(--bg-subtle)",
      border: "1px solid var(--line)", borderRadius: 10, gap: 2,
    }}>
      {options.map((o) => {
        const v = typeof o === "string" ? o : o.value;
        const label = typeof o === "string" ? o : o.label;
        const ico = typeof o === "object" ? o.icon : null;
        const sel = v === value;
        return (
          <button
            key={v} onClick={() => onChange(v)}
            style={{
              height: h, padding: "0 12px", borderRadius: 8,
              fontSize: 12.5, fontWeight: 500, fontFamily: "inherit",
              background: sel ? "var(--card)" : "transparent",
              color: sel ? "var(--fg)" : "var(--mute)",
              border: sel ? "1px solid var(--line)" : "1px solid transparent",
              boxShadow: sel ? "0 1px 2px rgba(0,0,0,0.04)" : "none",
              display: "inline-flex", alignItems: "center", gap: 6,
              cursor: "pointer", transition: "all .15s ease",
            }}
          >
            {ico && <Icon name={ico} size={13} />}
            {label}
          </button>
        );
      })}
    </div>
  );
}

// Tag / Chip
function Tag({ children, tone = "neutral", style = {}, mono }) {
  const tones = {
    neutral: { bg: "var(--bg-subtle)", fg: "var(--fg-2)", bd: "var(--line)" },
    accent:  { bg: "var(--acc-soft)",  fg: "var(--acc)",  bd: "var(--acc-line)" },
    green:   { bg: "var(--green-soft)",fg: "var(--green)",bd: "transparent" },
    amber:   { bg: "var(--amber-soft)",fg: "var(--amber)",bd: "transparent" },
    red:     { bg: "var(--red-soft)",  fg: "var(--red)",  bd: "transparent" },
    blue:    { bg: "var(--blue-soft)", fg: "var(--blue)", bd: "transparent" },
    outline: { bg: "transparent", fg: "var(--mute)", bd: "var(--line)" },
  };
  const t = tones[tone] || tones.neutral;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "2px 8px", borderRadius: 999,
      fontSize: 11, fontWeight: 500,
      lineHeight: 1.5,
      background: t.bg, color: t.fg, border: `1px solid ${t.bd}`,
      fontFamily: mono ? "var(--font-mono)" : "inherit",
      letterSpacing: mono ? "-0.02em" : 0,
      ...style,
    }}>{children}</span>
  );
}

// Inline label-value row used a lot in detail/settings
function Field({ label, hint, children, layout = "row" }) {
  if (layout === "col") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <label style={{ fontSize: 12, color: "var(--mute)", fontWeight: 500 }}>{label}</label>
        {children}
        {hint && <div style={{ fontSize: 11.5, color: "var(--mute-2)" }}>{hint}</div>}
      </div>
    );
  }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16, minHeight: 32 }}>
      <label style={{ fontSize: 12.5, color: "var(--fg-2)", fontWeight: 500, minWidth: 112, flexShrink: 0 }}>{label}</label>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
        {children}
      </div>
      {hint && <div style={{ fontSize: 11.5, color: "var(--mute-2)", flexShrink: 0 }}>{hint}</div>}
    </div>
  );
}

// Section block — used in long pages instead of nested Cards
function Section({ title, hint, right, children, defaultOpen = true, collapsible = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section style={{
      background: "var(--card)", border: "1px solid var(--line)",
      borderRadius: 14, overflow: "hidden",
    }}>
      <header
        onClick={collapsible ? () => setOpen(o => !o) : undefined}
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "14px 18px", gap: 12,
          cursor: collapsible ? "pointer" : "default",
          userSelect: "none",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 600, color: "var(--fg)", letterSpacing: "-0.005em" }}>{title}</h3>
          {hint && <span style={{ fontSize: 12, color: "var(--mute)" }}>{hint}</span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {right}
          {collapsible && (
            <Icon name="chevDown" size={16} style={{
              color: "var(--mute)",
              transform: open ? "rotate(0)" : "rotate(-90deg)",
              transition: "transform .2s ease",
            }} />
          )}
        </div>
      </header>
      {open && (
        <>
          <Divider />
          <div style={{ padding: 18 }}>{children}</div>
        </>
      )}
    </section>
  );
}

// Toggle switch
function Toggle({ checked, onChange }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      style={{
        width: 36, height: 20, borderRadius: 999,
        background: checked ? "var(--acc)" : "var(--line-strong)",
        border: "none", padding: 2, cursor: "pointer",
        transition: "background .15s ease", flexShrink: 0,
      }}
    >
      <div style={{
        width: 16, height: 16, borderRadius: "50%",
        background: "#fff",
        transform: `translateX(${checked ? 16 : 0}px)`,
        transition: "transform .15s ease",
        boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
      }} />
    </button>
  );
}

// Progress bar
function Progress({ value, tone = "accent", height = 4 }) {
  const colorMap = {
    accent: "var(--acc)",
    green:  "var(--green)",
    amber:  "var(--amber)",
    red:    "var(--red)",
  };
  return (
    <div style={{
      width: "100%", height, borderRadius: 999,
      background: "var(--line)", overflow: "hidden",
    }}>
      <div style={{
        width: `${Math.max(0, Math.min(100, value))}%`,
        height: "100%", borderRadius: 999,
        background: colorMap[tone],
        transition: "width .3s ease",
      }} />
    </div>
  );
}

// Mini text input
function Input({ value, onChange, placeholder, mono, readOnly, size = "md", style = {}, type = "text" }) {
  const h = size === "sm" ? 28 : 32;
  return (
    <input
      type={type} value={value} placeholder={placeholder} readOnly={readOnly}
      onChange={(e) => onChange?.(e.target.value)}
      style={{
        height: h, padding: "0 10px", borderRadius: 8,
        border: "1px solid var(--line-strong)",
        background: readOnly ? "var(--bg-subtle)" : "var(--card)",
        color: "var(--fg)", fontSize: 13, fontFamily: mono ? "var(--font-mono)" : "inherit",
        outline: "none",
        ...style,
      }}
    />
  );
}

// FK Logo — recreate from src/assets/FusionKit.svg
function FKLogo({ size = 40 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" style={{ borderRadius: size * 0.21 }}>
      <rect width="512" height="512" rx="108" fill="var(--fk-logo-bg, #09090b)" />
      <rect x="128" y="124" width="196" height="196" rx="36" fill="var(--fk-logo-gray, #a1a1aa)" />
      <rect x="188" y="192" width="196" height="196" rx="36" fill="#ffffff" />
    </svg>
  );
}

// Tool icon badge — used on tool cards
function ToolBadge({ tone, icon, size = 36 }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: 10,
      background: `color-mix(in oklch, ${tone} 14%, transparent)`,
      border: `1px solid color-mix(in oklch, ${tone} 28%, transparent)`,
      color: tone,
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      flexShrink: 0,
    }}>
      <Icon name={icon} size={Math.round(size * 0.48)} stroke={1.8} />
    </div>
  );
}

Object.assign(window, {
  Icon, Card, Divider, PageHeader,
  Button, IconBtn, Segmented, Tag, Field, Section,
  Toggle, Progress, Input, FKLogo, ToolBadge,
});
