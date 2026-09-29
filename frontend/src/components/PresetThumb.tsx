import type { Preset, ZoneCanvas } from "@excontrol/shared";

/** A preset drawn as a tiny screen: the output cells as a faint grid, each layer as a
 *  rounded window labelled with its input. Same input → same colour on every thumbnail,
 *  so a customer can follow "the laptop" from one layout to the next. */

const HUES = ["#4f86f3", "#2ea0a0", "#d29922", "#a371f7", "#e5689c", "#3fb950", "#f0883e"];
const hueFor = (source: string) => {
  let h = 0;
  for (const c of source) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length]!;
};
/** "input 4-1" → "4-1"; custom input names stay as they are */
const shortName = (s: string) => s.replace(/^input\s+/i, "");

const H = 100; // viewBox height; width follows the canvas aspect

export function PresetThumb({ preset, canvas }: { preset: Preset; canvas?: ZoneCanvas }) {
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
        const color = hueFor(l.source);
        const noSignal = l.signal === false;
        const fs = Math.max(4.5, Math.min(11, h * 0.2, w * 0.14));
        return (
          <g key={i}>
            <rect
              x={x + 0.6} y={y + 0.6} width={Math.max(0, w - 1.2)} height={Math.max(0, h - 1.2)} rx="1.8"
              fill={noSignal ? `url(#${id})` : color} fillOpacity={noSignal ? 1 : 0.82}
              stroke={color} strokeWidth="0.9" strokeOpacity={noSignal ? 0.7 : 1}
            />
            {w > 14 && h > 9 && (
              <text x={x + w / 2} y={y + h / 2} className="pthumb-label" fontSize={fs} dominantBaseline="central" textAnchor="middle">
                {shortName(l.source)}
                {noSignal && h > 22 && <tspan x={x + w / 2} dy={fs * 1.15} fontSize={fs * 0.7} className="pthumb-sub">no signal</tspan>}
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
