import { useId } from "react";

/** Decorative, code-drawn panels stay sharp at any window scale. */
export function FeaturedToolArtwork({ kind }: { kind: "studio" | "knowledge" }) {
  const id = useId().replace(/:/g, "");
  const panel = `${id}-panel`;
  const glass = `${id}-glass`;
  const shadow = `${id}-shadow`;
  return (
    <svg aria-hidden="true" focusable="false" className="featured-tool-art" viewBox="0 0 300 320" fill="none">
      <defs>
        <linearGradient id={panel} x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="currentColor" stopOpacity=".28" />
          <stop offset="1" stopColor="currentColor" stopOpacity=".07" />
        </linearGradient>
        <linearGradient id={glass} x1="0" y1="0" x2=".8" y2="1">
          <stop stopColor="var(--art-paper)" stopOpacity=".96" />
          <stop offset="1" stopColor="var(--art-paper)" stopOpacity=".55" />
        </linearGradient>
        <filter id={shadow} x="-50%" y="-30%" width="200%" height="180%">
          <feDropShadow dx="0" dy="16" stdDeviation="12" floodColor="currentColor" floodOpacity=".13" />
        </filter>
      </defs>
      {kind === "studio" ? <>
        <g transform="translate(14 18) skewY(16)" filter={`url(#${shadow})`}>
          <rect x="90" y="18" width="163" height="160" rx="12" fill={`url(#${panel})`} stroke="var(--art-edge)" strokeWidth="2" />
          <rect x="12" y="42" width="175" height="137" rx="12" fill={`url(#${panel})`} stroke="var(--art-edge)" strokeWidth="2" />
          <g stroke="currentColor" strokeWidth="3" strokeLinecap="round" opacity=".5">
            {[18, 38, 57, 31, 66, 47, 78, 52, 62, 37, 49, 26, 15].map((height, index) =>
              <path key={index} d={`M${30 + index * 5} ${108 - height / 2}v${height}`} />)}
          </g>
          <rect x="130" y="67" width="48" height="52" rx="9" fill="currentColor" opacity=".62" />
          <text x="154" y="103" textAnchor="middle" fill="var(--art-paper)" fontSize="32" fontFamily="sans-serif">A</text>
          <rect x="176" y="99" width="53" height="55" rx="10" fill={`url(#${glass})`} stroke="var(--art-edge)" strokeWidth="2" />
          <text x="202" y="137" textAnchor="middle" fill="currentColor" fontSize="30" fontFamily="sans-serif">文</text>
        </g>
        <g transform="translate(72 196) skewY(16)" filter={`url(#${shadow})`}>
          <rect width="180" height="74" rx="10" fill={`url(#${glass})`} stroke="var(--art-edge)" strokeWidth="2" />
          <rect x="10" y="10" width="160" height="24" rx="5" fill="var(--art-paper)" opacity=".6" />
          <text x="20" y="27" className="art-sample" fontSize="13">こんにちは、世界</text>
          <text x="20" y="57" className="art-sample" fontSize="13">Hello, world.</text>
        </g>
      </> : <g transform="translate(8 61) skewY(-16)" filter={`url(#${shadow})`}>
        <path d="M49 22a12 12 0 0 1 12-12h55l13 14h65a12 12 0 0 1 12 12v166a12 12 0 0 1-12 12H61a12 12 0 0 1-12-12Z" fill={`url(#${panel})`} stroke="var(--art-edge)" strokeWidth="2" />
        <rect x="68" y="46" width="154" height="196" rx="12" fill={`url(#${glass})`} stroke="var(--art-edge)" strokeWidth="2" />
        <rect x="92" y="71" width="153" height="196" rx="12" fill={`url(#${panel})`} stroke="var(--art-edge)" strokeWidth="2" />
        <rect x="111" y="89" width="150" height="191" rx="12" fill={`url(#${glass})`} stroke="var(--art-edge)" strokeWidth="2" />
        <g fill="currentColor">
          <rect x="128" y="109" width="27" height="27" rx="6" opacity=".17" />
          <path d="M135 116h5a4 4 0 0 1 4 2 4 4 0 0 1 4-2h2v13h-3a4 4 0 0 0-3 1 4 4 0 0 0-3-1h-6Z" opacity=".7" />
          <rect x="164" y="114" width="67" height="5" rx="2.5" opacity=".48" />
          <rect x="164" y="124" width="44" height="4" rx="2" opacity=".2" />
          {[155, 199, 243].map((y, index) => <g key={y}>
            <rect x="130" y={y} width={60 + index * 8} height="5" rx="2.5" opacity=".44" />
            <rect x="130" y={y + 12} width="104" height="4" rx="2" opacity=".16" />
            <path d={`M130 ${y + 28}h104`} stroke="currentColor" strokeOpacity=".12" />
          </g>)}
        </g>
        <g transform="translate(28 154)">
          <rect width="62" height="58" rx="10" fill={`url(#${glass})`} stroke="var(--art-edge)" strokeWidth="2" />
          <path d="M15 19h12v12h-6c0 6-2 9-6 12v-7c3-2 3-4 3-5h-3Zm23 0h12v12h-6c0 6-2 9-6 12v-7c3-2 3-4 3-5h-3Z" fill="currentColor" opacity=".46" />
        </g>
      </g>}
    </svg>
  );
}
