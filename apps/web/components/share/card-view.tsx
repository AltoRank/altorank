import type { CSSProperties } from "react";
import { CARD_WIDTH, CARD_HEIGHT, type ShareCard } from "@/lib/share/card";

/**
 * The card itself, drawn once for two renderers.
 *
 * Inline styles and flexbox only, no Tailwind, no grid: the OG route feeds
 * this to satori, which understands roughly that subset and nothing else,
 * and the dialog rasterises the same DOM with html-to-image. One component,
 * so the PNG someone downloads and the image a link unfurls to are the same
 * picture.
 */
const INK = "#15161a";
const INK_2 = "#8a8f98";
const LINE = "#2a2c33";
const BG = "#0c0d10";
const ACCENT = "#5763ec";

const font = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const mono = "ui-monospace, SFMono-Regular, Menlo, monospace";

export function ShareCardView({ card, style }: { card: ShareCard; style?: CSSProperties }) {
  const cols = Math.max(1, Math.min(4, card.stats.length));
  const statWidth = (CARD_WIDTH - 72 * 2 - 24 * (cols - 1)) / cols;
  return (
    <div
      style={{
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: 72,
        background: BG,
        color: "#f4f4f5",
        fontFamily: font,
        ...style,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", fontSize: 22, color: INK_2, letterSpacing: 0.5 }}>
          <div style={{ width: 12, height: 12, borderRadius: 6, background: ACCENT, marginRight: 12 }} />
          Content and search progress
        </div>
        <div style={{ display: "flex", marginTop: 14, fontSize: 60, fontWeight: 700, letterSpacing: -1.5, fontFamily: mono }}>
          {card.domain || "—"}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "row" }}>
        {card.stats.map((s, i) => (
          <div
            key={s.label}
            style={{
              display: "flex",
              flexDirection: "column",
              width: statWidth,
              marginLeft: i === 0 ? 0 : 24,
              padding: "26px 28px",
              background: INK,
              border: `1px solid ${LINE}`,
              borderRadius: 18,
            }}
          >
            <div style={{ display: "flex", fontSize: 64, fontWeight: 700, letterSpacing: -2, lineHeight: 1 }}>{s.value}</div>
            <div style={{ display: "flex", marginTop: 14, fontSize: 20, color: INK_2, lineHeight: 1.25 }}>{s.label}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 20, color: INK_2 }}>
        <div style={{ display: "flex" }}>Every number is measured. Nothing here is estimated.</div>
        {card.footer && <div style={{ display: "flex", fontFamily: mono }}>{card.footer}</div>}
      </div>
    </div>
  );
}
