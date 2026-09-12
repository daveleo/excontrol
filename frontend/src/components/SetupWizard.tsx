import { useEffect, useMemo, useState } from "react";
import type { DeviceType, SetupDevice, SetupState, SetupZone, SetupEpsOutput, ProbeResult, ScanHit } from "@excontrol/shared";
import { getSetupState, probeDevice, scanNetwork, saveSetup } from "../api.js";

const TYPE_LABEL: Record<DeviceType, string> = {
  "novastar-h": "NovaStar H-series",
  "novastar-coex": "NovaStar COEX (MX40 Pro…)",
  "expromo-eps": "Expromo EPS power",
  obs: "OBS Studio",
};
const TYPE_SHORT: Record<DeviceType, string> = {
  "novastar-h": "H-series",
  "novastar-coex": "COEX",
  "expromo-eps": "EPS",
  obs: "OBS",
};
const HAS_ZONES = (t: DeviceType) => t === "novastar-h" || t === "novastar-coex";

type ProbeCache = Record<string, { pending?: boolean; result?: ProbeResult }>;

export function SetupWizard({
  initial,
  onClose,
  epsOff = new Set(),
}: {
  initial: SetupState;
  onClose: () => void;
  /** ids of EPS devices currently powered off — a failed Test on their equipment is expected */
  epsOff?: Set<string>;
}) {
  const [devices, setDevices] = useState<SetupDevice[]>(initial.devices);
  const [probes, setProbes] = useState<ProbeCache>({});
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [scan, setScan] = useState<{ running: boolean; hits?: ScanHit[]; subnets?: string[]; err?: string }>({ running: false });

  const defaultPort = (t: DeviceType) => initial.defaultPorts[t];

  const idError = useMemo(() => {
    const seen = new Set<string>();
    for (const d of devices) {
      const id = d.id.trim();
      if (!id) return "Every device needs an id.";
      if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) return `Device id "${id}" — letters, digits and hyphens only.`;
      if (seen.has(id)) return `Duplicate device id "${id}".`;
      seen.add(id);
    }
    return null;
  }, [devices]);

  const mutate = (idx: number, patch: Partial<SetupDevice>) =>
    setDevices((ds) => {
      const before = ds[idx];
      const renamed = patch.id !== undefined && before && patch.id !== before.id ? { from: before.id, to: patch.id } : null;
      return ds.map((d, i) => {
        if (i === idx) return { ...d, ...patch };
        // keep `poweredBy` pointing at a renamed EPS
        if (renamed && d.poweredBy === renamed.from) return { ...d, poweredBy: renamed.to };
        return d;
      });
    });

  const freshId = (type: DeviceType, taken: Set<string>) => {
    const stem = { "novastar-h": "h", "novastar-coex": "coex", "expromo-eps": "eps", obs: "obs" }[type];
    if (!taken.has(stem)) return stem;
    for (let n = 2; ; n++) if (!taken.has(`${stem}-${n}`)) return `${stem}-${n}`;
  };

  const addDevice = (type: DeviceType, host = "") => {
    setDevices((ds) => {
      const id = freshId(type, new Set(ds.map((d) => d.id)));
      const d: SetupDevice = {
        id,
        type,
        label: TYPE_LABEL[type].replace(/ \(.*/, ""),
        enabled: true,
        host,
        port: defaultPort(type),
        poweredBy: null,
        ...(type === "novastar-h" ? { pId: "", secretKey: "", encrypted: false, zones: [] } : {}),
        ...(type === "novastar-coex" ? { zones: [] } : {}),
        ...(type === "expromo-eps" ? { independentOutputs: false, outputs: [] } : {}),
        ...(type === "obs" ? { password: "", host: host || "127.0.0.1" } : {}),
      };
      return [...ds, d];
    });
  };

  const removeDevice = (idx: number) =>
    setDevices((ds) => {
      const gone = ds[idx]?.id;
      return ds.filter((_, i) => i !== idx).map((d) => (d.poweredBy === gone ? { ...d, poweredBy: null } : d));
    });

  const runProbe = async (idx: number) => {
    const d = devices[idx];
    if (!d) return;
    setProbes((p) => ({ ...p, [d.id]: { pending: true, result: p[d.id]?.result } }));
    try {
      const result = await probeDevice(d);
      setProbes((p) => ({ ...p, [d.id]: { result } }));
    } catch (e) {
      setProbes((p) => ({ ...p, [d.id]: { result: { ok: false, detail: e instanceof Error ? e.message : String(e) } } }));
    }
  };

  const runScan = async () => {
    setScan({ running: true });
    try {
      const r = await scanNetwork();
      setScan({ running: false, hits: r.hits, subnets: r.subnets });
    } catch (e) {
      setScan({ running: false, err: e instanceof Error ? e.message : String(e) });
    }
  };

  const dirty = useMemo(
    () => JSON.stringify(devices) !== JSON.stringify(initial.devices),
    [devices, initial],
  );
  const close = () => {
    if (dirty && !confirm("Discard your changes to the device setup?")) return;
    onClose();
  };

  const [reconnecting, setReconnecting] = useState<number | null>(null);

  const save = async () => {
    if (idError) return;
    if (initial.configured && devices.length === 0 && !confirm("This removes every device. The setup wizard will reappear until you add one. Continue?")) return;
    setSaving(true);
    setSaveErr(null);
    try {
      const res = await saveSetup({ devices });
      if (res.portChanged) {
        setReconnecting(res.port);
        followToPort(res.port);
        return; // don't close — we're about to navigate away
      }
      onClose();
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  /** The server rebinds to the new port a moment after responding — poll for it, then follow. */
  const followToPort = (port: number) => {
    const target = `${location.protocol}//${location.hostname}:${port}/`;
    const tryOnce = (attempt: number) => {
      fetch(`${location.protocol}//${location.hostname}:${port}/health`, { signal: AbortSignal.timeout(1500) })
        .then(() => (location.href = target))
        .catch(() => (attempt < 15 ? setTimeout(() => tryOnce(attempt + 1), 500) : (location.href = target)));
    };
    setTimeout(() => tryOnce(0), 500);
  };

  const epsDevices = devices.filter((d) => d.type === "expromo-eps");
  const knownHosts = new Set(devices.map((d) => `${d.host}:${d.port}`));

  if (reconnecting != null) {
    return (
      <div className="wizard">
        <div className="wiz-scroll">
          <div className="wiz-inner">
            <p className="loading">Saved. Reconnecting on port {reconnecting}…</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="wizard">
      <div className="wiz-scroll">
      <div className="wiz-inner">
        <header className="wiz-head">
          <div>
            <h1>{initial.configured ? "Devices" : `Welcome to ${initial.app.name}`}</h1>
            <p>
              {initial.configured
                ? "Add, edit or remove the devices this controller talks to."
                : "Add the LED controllers, power units and OBS on this network. Everything is optional — set up only what you have."}
            </p>
          </div>
          {initial.configured && (
            <button className="wiz-x" onClick={close} aria-label="Close">✕</button>
          )}
        </header>

        <section className="wiz-scan">
          <button className="primary" disabled={scan.running} onClick={runScan}>
            {scan.running ? "Scanning the network…" : "Scan network for devices"}
          </button>
          {scan.subnets && <span className="muted small">Looked at {scan.subnets.map((s) => `${s}.0/24`).join(", ")}</span>}
          {scan.err && <span className="probe-bad small">{scan.err}</span>}
          {scan.hits && scan.hits.length === 0 && <span className="muted small">Nothing answered on the known control ports.</span>}
          {scan.hits && scan.hits.length > 0 && (
            <ul className="scan-hits">
              {scan.hits.map((h) => {
                const added = knownHosts.has(`${h.host}:${h.port}`);
                return (
                  <li key={`${h.host}:${h.port}`}>
                    <code>{h.host}:{h.port}</code>
                    <span className="muted">likely {TYPE_SHORT[h.guess]}</span>
                    <button disabled={added} onClick={() => addDevice(h.guess, h.host)}>
                      {added ? "added" : `Add as ${TYPE_SHORT[h.guess]}`}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <div className="wiz-devices">
          {devices.length === 0 && <p className="muted">No devices yet. Scan the network or add one below.</p>}
          {devices.map((d, idx) => (
            <DeviceForm
              key={idx}
              d={d}
              epsDevices={epsDevices}
              probe={probes[d.id]}
              onChange={(patch) => mutate(idx, patch)}
              onRemove={() => removeDevice(idx)}
              onTest={() => runProbe(idx)}
              defaultPort={defaultPort(d.type)}
              powerOff={!!d.poweredBy && epsOff.has(d.poweredBy)}
            />
          ))}
        </div>

        <AddDevice onAdd={addDevice} />
      </div>
      </div>

      <footer className="wiz-foot">
        <div className="wiz-foot-inner">
          {idError && <span className="probe-bad">{idError}</span>}
          {saveErr && <span className="probe-bad">{saveErr}</span>}
          <div className="spacer" />
          {initial.configured && <button onClick={close} disabled={saving}>Cancel</button>}
          <button className="primary" disabled={saving || !!idError || devices.length === 0} onClick={save}>
            {saving ? "Saving…" : initial.configured ? "Save changes" : "Save & start"}
          </button>
        </div>
      </footer>
    </div>
  );
}

function AddDevice({ onAdd }: { onAdd: (t: DeviceType) => void }) {
  const [type, setType] = useState<DeviceType>("novastar-h");
  return (
    <div className="wiz-add">
      <select value={type} onChange={(e) => setType(e.target.value as DeviceType)}>
        {(Object.keys(TYPE_LABEL) as DeviceType[]).map((t) => (
          <option key={t} value={t}>{TYPE_LABEL[t]}</option>
        ))}
      </select>
      <button onClick={() => onAdd(type)}>+ Add device</button>
    </div>
  );
}

function DeviceForm({
  d, epsDevices, probe, onChange, onRemove, onTest, defaultPort, powerOff,
}: {
  d: SetupDevice;
  epsDevices: SetupDevice[];
  probe?: { pending?: boolean; result?: ProbeResult };
  onChange: (patch: Partial<SetupDevice>) => void;
  onRemove: () => void;
  onTest: () => void;
  defaultPort: number;
  powerOff?: boolean;
}) {
  const [showKeyHelp, setShowKeyHelp] = useState(false);
  // Collapsed by default so opening Devices gives an overview of everything configured,
  // not a wall of forms — expand one at a time to edit it.
  const [collapsed, setCollapsed] = useState(true);
  const zones = d.zones ?? [];
  const result = probe?.result;

  const setZone = (i: number, patch: Partial<SetupZone>) =>
    onChange({ zones: zones.map((z, zi) => (zi === i ? { ...z, ...patch } : z)) });
  const addZone = () =>
    onChange({ zones: [...zones, { id: `z${zones.length + 1}`, label: `Zone ${zones.length + 1}`, screenId: d.type === "novastar-h" ? 0 : "" }] });
  const removeZone = (i: number) => onChange({ zones: zones.filter((_, zi) => zi !== i) });
  const useDetectedZones = () => result?.zones && onChange({ zones: result.zones });

  // EPS independent output control: the whole-unit Power on/off button (above) is unaffected
  // either way — this only exposes up to 6 named relays as separately switchable outputs.
  const outputs = d.outputs ?? [];
  const outputAt = (index: number) => outputs.find((o) => o.index === index);
  const setOutput = (index: number, patch: Partial<SetupEpsOutput> | null) => {
    if (patch === null) {
      onChange({ outputs: outputs.filter((o) => o.index !== index) });
      return;
    }
    const existing = outputAt(index);
    const next = existing
      ? outputs.map((o) => (o.index === index ? { ...o, ...patch } : o))
      : [...outputs, { id: `o${index}`, label: `Output ${index}`, index, ...patch }];
    onChange({ outputs: next.sort((a, b) => a.index - b.index) });
  };

  return (
    <div className={`wiz-device ${d.enabled ? "" : "off"} ${collapsed ? "collapsed" : ""}`}>
      <div className="wd-top">
        <button
          className="wd-toggle" onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? "Expand" : "Collapse"} aria-expanded={!collapsed}
        >
          {collapsed ? "▸" : "▾"}
        </button>
        <span className="wd-badge">{TYPE_SHORT[d.type]}</span>
        <input
          className="wd-label" value={d.label} placeholder="Friendly name"
          onChange={(e) => onChange({ label: e.target.value })}
        />
        <label className="wd-id">
          id
          <input value={d.id} onChange={(e) => onChange({ id: e.target.value.trim() })} />
        </label>
        {collapsed && <span className="wd-summary muted small">{d.host || "no address"}:{d.port}</span>}
        <label className="toggle">
          <input type="checkbox" checked={d.enabled} onChange={(e) => onChange({ enabled: e.target.checked })} />
          Enabled
        </label>
        <button className="wd-remove" onClick={onRemove} aria-label="Remove device">Remove</button>
      </div>

      {!collapsed && (
      <>
      <div className="wd-grid">
        <label className="field">
          <span>IP address</span>
          <input value={d.host} placeholder="172.22.40.10" onChange={(e) => onChange({ host: e.target.value.trim() })} />
        </label>
        <label className="field narrow">
          <span>Port</span>
          <input
            type="number" value={d.port}
            onChange={(e) => onChange({ port: Number(e.target.value) || defaultPort })}
          />
        </label>

        {d.type === "novastar-h" && (
          <>
            <label className="field">
              <span>OpenAPI Project ID</span>
              <input value={d.pId ?? ""} onChange={(e) => onChange({ pId: e.target.value.trim() })} />
            </label>
            <label className="field">
              <span>OpenAPI Secret Key</span>
              <input
                type="password" value={d.secretKey ?? ""} placeholder="8 characters"
                onChange={(e) => onChange({ secretKey: e.target.value })}
              />
            </label>
            <label className="toggle">
              <input type="checkbox" checked={!!d.encrypted} onChange={(e) => onChange({ encrypted: e.target.checked })} />
              Encryption enabled on the controller
            </label>
          </>
        )}

        {d.type === "obs" && (
          <label className="field">
            <span>WebSocket password</span>
            <input
              type="password" value={d.password ?? ""}
              onChange={(e) => onChange({ password: e.target.value })}
            />
          </label>
        )}

        {d.type !== "expromo-eps" && (
          <label className="field">
            <span>Powered by</span>
            <select value={d.poweredBy ?? ""} onChange={(e) => onChange({ poweredBy: e.target.value || null })}>
              <option value="">Always on</option>
              {epsDevices.map((e) => <option key={e.id} value={e.id}>{e.label || e.id}</option>)}
            </select>
          </label>
        )}
      </div>

      {d.type === "expromo-eps" && (
        <div className="wd-outputs">
          <label className="toggle">
            <input
              type="checkbox" checked={!!d.independentOutputs}
              onChange={(e) => onChange({ independentOutputs: e.target.checked })}
            />
            Enable independent output control
          </label>
          <span className="muted small">
            The Power on/off button above always controls the whole unit. Turning this on adds
            named on/off buttons for individual relays, shown in this EPS's dashboard cell.
          </span>
          {d.independentOutputs && (
            <div className="wd-output-rows">
              {[1, 2, 3, 4, 5, 6].map((idx) => {
                const o = outputAt(idx);
                return (
                  <div className="wd-output-row" key={idx}>
                    <label className="toggle">
                      <input
                        type="checkbox" checked={!!o}
                        onChange={(e) => setOutput(idx, e.target.checked ? {} : null)}
                      />
                      Relay {idx}
                    </label>
                    <input
                      className="z-label" placeholder={`Output ${idx} name`}
                      value={o?.label ?? ""} disabled={!o}
                      onChange={(e) => setOutput(idx, { label: e.target.value })}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {d.type === "novastar-h" && (
        <div className="wd-help">
          <button className="linkish" onClick={() => setShowKeyHelp((v) => !v)}>
            {showKeyHelp ? "▾" : "▸"} How do I get the OpenAPI Project ID and Secret Key?
          </button>
          {showKeyHelp && (
            <ol>
              <li>On the controller (or NovaLCT / the web UI), open <b>Settings → OpenAPI</b>.</li>
              <li><b>Add</b> an entry. It generates a <b>Project ID</b> and <b>Secret Key</b> — copy both here.</li>
              <li>Make sure the entry's <b>Disable</b> toggle is <b>blue / on</b> — on these controllers blue means <i>active</i>, not disabled.</li>
              <li>Leave <b>Encryption</b> off unless you tick the box above to match.</li>
              <li>The Secret Key must be exactly <b>8 characters</b>.</li>
            </ol>
          )}
        </div>
      )}

      {HAS_ZONES(d.type) && (
        <div className="wd-zones">
          <div className="wd-zones-head">
            <span>Screens / zones</span>
            <span className="muted small">Leave empty to detect automatically on connect.</span>
          </div>
          {zones.map((z, i) => (
            <div className="wd-zone" key={i}>
              <input className="z-label" value={z.label} placeholder="North Wall" onChange={(e) => setZone(i, { label: e.target.value })} />
              <input className="z-id" value={z.id} placeholder="id" onChange={(e) => setZone(i, { id: e.target.value.trim() })} />
              <label className="z-screen">
                {d.type === "novastar-h" ? "screen #" : "screen id"}
                <input
                  value={String(z.screenId)}
                  onChange={(e) => setZone(i, { screenId: d.type === "novastar-h" ? Number(e.target.value) || 0 : e.target.value.trim() })}
                />
              </label>
              <button onClick={() => removeZone(i)} aria-label="Remove zone">✕</button>
            </div>
          ))}
          <div className="wd-zone-actions">
            <button onClick={addZone}>+ Zone</button>
            {result?.ok && result.zones && result.zones.length > 0 && (
              <button onClick={useDetectedZones}>Use {result.zones.length} detected</button>
            )}
          </div>
        </div>
      )}

      <div className="wd-test">
        <button onClick={onTest} disabled={probe?.pending}>
          {probe?.pending ? "Testing…" : "Test connection"}
        </button>
        {result && (
          <span className={result.ok ? "probe-ok" : "probe-bad"}>
            {result.ok ? "✓ " : "✗ "}{result.detail}{result.info ? ` (${result.info})` : ""}
          </span>
        )}
        {!result && powerOff && d.type !== "expromo-eps" && (
          <span className="muted small">Its power unit is off — this will only connect once the equipment is powered on.</span>
        )}
      </div>
      </>
      )}
    </div>
  );
}

/** Fetches setup state on demand and renders the wizard. Used for the re-openable "Devices" panel. */
export function SetupWizardLoader({ onClose, epsOff }: { onClose: () => void; epsOff?: Set<string> }) {
  const [state, setState] = useState<SetupState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    getSetupState().then(setState).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);
  if (err) return <div className="wizard"><div className="wiz-scroll"><div className="wiz-inner"><p className="probe-bad">{err}</p><button onClick={onClose}>Close</button></div></div></div>;
  if (!state) return <div className="wizard"><div className="wiz-scroll"><div className="wiz-inner"><p className="muted">Loading…</p></div></div></div>;
  return <SetupWizard initial={state} onClose={onClose} epsOff={epsOff} />;
}
