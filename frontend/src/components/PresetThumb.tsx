import type { Preset, ZoneCanvas } from "@excontrol/shared";

/** A preset drawn as a tiny screen: the output cells as a faint grid, each layer as a
 *  rounded window labelled (top-left, like the controller's own UI) with its input. Same
 *  input → same colour on every thumbnail, so a customer can follow "the laptop" from one
 *  layout to the next. */

const HUES = ["#4f86f3", "#e0823d", "#2fb3a0", "#a371f7", "#e5689c", "#d4b12a", "#3fb950", "#6e8bd8"];

/** Colours by input, handed out in sorted order over every input in use — distinct as long
 *  as there are ≤ 8 inputs, and stable between thumbnails and screens. */
export function sourceColors(sources: Iterable<string>): Map<string, string> {
  const sorted = [...new Set(sources)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return new Map(sorted.map((s, i) => [s, HUES[i % HUES.length]!]));
}
/** "input 4-1" → "4-1"; custom input names stay as they are */
const shortName = (s: string) => s.replace(/^input\s+/i, "");

const H = 100; // viewBox height; width follows the canvas aspect

export function PresetThumb({
  preset, canvas, colors, nameOf = shortName,
}: {
  preset: Preset;
  canvas?: ZoneCanvas;
  colors: Map<string, string>;
  /** the customer's name for an input (Setup › device › Input names) */
  nameOf?: (source: string) => string;
}) {
  const W = canvas ? (canvas.width / canvas.height) * H : (16 / 9) * H;
  const layers = preset.layers ?? [];
  const id = `hatch-${preset.id}-${Math.round(W)}`;
  return (
    <svg className="pthumb" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${preset.name} layout`}>
      <defs>
        <pattern id={id} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="4" height="4" fill="#161b22" />
          <line x1="0" y1="0" x2="0" y2="4" stroke="#8b949e" strokeWidth="1.2" strokeOpacity="0.35" />
        </pattern>
      </defs>
      <rect className="pthumb-bg" x="0" y="0" width={W} height={H} rx="3" />
      {canvas?.cells.map((c, i) => (
        <rect key={i} className="pthumb-cell" x={c.x * W} y={c.y * H} width={c.w * W} height={c.h * H} />
      ))}
      {layers.map((l, i) => {
        const x = l.x * W, y = l.y * H, w = l.w * W, h = l.h * H;
        const color = colors.get(l.source) ?? HUES[0]!;
        const noSignal = l.signal === false;
        const fs = Math.max(4, Math.min(9, h * 0.22, w * 0.16));
        return (
          <g key={i}>
            <rect
              x={x + 0.6} y={y + 0.6} width={Math.max(0, w - 1.2)} height={Math.max(0, h - 1.2)} rx="1.8"
              fill={noSignal ? `url(#${id})` : color} fillOpacity={noSignal ? 1 : 0.82}
              stroke={color} strokeWidth="0.9" strokeOpacity={noSignal ? 0.7 : 1}
            />
            {w > 12 && h > 8 && (
              <text x={x + 2.2} y={y + 1.8 + fs * 0.5} className="pthumb-label" fontSize={fs} dominantBaseline="central">
                {nameOf(l.source)}
                {noSignal && h > 18 && <tspan x={x + 2.2} dy={fs * 1.2} fontSize={fs * 0.75} className="pthumb-sub">no signal</tspan>}
              </text>
            )}
          </g>
        );
      })}
      {!layers.length && (
        <text x={W / 2} y={H / 2} className="pthumb-empty" fontSize="9" dominantBaseline="central" textAnchor="middle">
          {preset.layers ? "empty" : preset.name}
        </text>
      )}
    </svg>
  );
}
