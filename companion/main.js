const { InstanceBase, runEntrypoint, InstanceStatus, combineRgb } = require('@companion-module/base')

/**
 * Developer/unpublished Companion module for eXcontrol. Talks to eXcontrol's existing REST
 * API (see docs/COMPANION.md in the main repo) — dropdown choices (zones, presets, scenes)
 * are read live from /api/state instead of hand-typed ids.
 */
class ExcontrolInstance extends InstanceBase {
  constructor(internal) {
    super(internal)
    this.state = null
    this.token = null
  }

  async init(config) {
    this.config = config
    await this.refreshState()
    this.updateActions()
    this.updateFeedbacks()
    this.updateVariableDefinitions()
  }

  async destroy() {}

  async configUpdated(config) {
    this.config = config
    this.token = null
    await this.refreshState()
    this.updateActions()
    this.updateFeedbacks()
    this.updateVariableDefinitions()
  }

  getConfigFields() {
    return [
      { type: 'textinput', id: 'host', label: 'eXcontrol host', width: 6, default: '127.0.0.1' },
      { type: 'number', id: 'port', label: 'Port', width: 6, default: 8080, min: 1, max: 65535 },
      {
        type: 'textinput',
        id: 'password',
        label: 'Access password (leave blank if none is set in eXcontrol Settings)',
        width: 12,
        default: '',
      },
    ]
  }

  baseUrl() {
    return `http://${this.config.host}:${this.config.port}`
  }

  async login() {
    const res = await fetch(this.baseUrl() + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: this.config.password }),
    })
    if (!res.ok) throw new Error('eXcontrol login failed — check the access password')
    const body = await res.json()
    this.token = body.token
  }

  async apiFetch(path, options = {}) {
    // eXcontrol's Fastify backend rejects a request that declares a JSON content-type but
    // sends no body (FST_ERR_CTP_EMPTY_JSON_BODY) — only bodyless routes like EPS power
    // on/off hit this, since every other action already sends a real JSON body.
    const headers = { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) }
    if (this.token) headers.authorization = `Bearer ${this.token}`
    const res = await fetch(this.baseUrl() + path, { ...options, headers })
    if (res.status === 401 && this.config.password && !options._retried) {
      await this.login()
      return this.apiFetch(path, { ...options, _retried: true })
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`eXcontrol ${path} -> HTTP ${res.status} ${body}`.trim())
    }
    return res.status === 204 ? null : res.json()
  }

  async refreshState() {
    this.updateStatus(InstanceStatus.Connecting)
    try {
      if (this.config.password) await this.login()
      this.state = await this.apiFetch('/api/state')
      this.updateStatus(InstanceStatus.Ok)
    } catch (e) {
      this.state = null
      this.updateStatus(InstanceStatus.ConnectionFailure, e.message)
    }
  }

  findZone(deviceId, zoneId) {
    const d = this.state?.devices?.find((x) => x.id === deviceId)
    return d?.zones?.find((z) => z.id === zoneId)
  }

  /** every (zone, preset) and (OBS zone, scene) pair, flattened to one dropdown choice. */
  presetChoices() {
    const out = []
    for (const d of this.state?.devices ?? []) {
      for (const z of d.zones ?? []) {
        for (const p of z.presets ?? []) {
          out.push({ id: `${d.id}:${z.id}:${p.id}`, label: `${d.label} · ${z.label} — ${p.name}` })
        }
      }
    }
    return out
  }

  /** zones that take brightness/blackout — NovaStar H/COEX only, not EPS/OBS. */
  zoneChoices() {
    const out = []
    for (const d of this.state?.devices ?? []) {
      if (d.type !== 'novastar-h' && d.type !== 'novastar-coex') continue
      for (const z of d.zones ?? []) {
        out.push({ id: `${d.id}:${z.id}`, label: `${d.label} · ${z.label}` })
      }
    }
    return out
  }

  epsChoices() {
    return (this.state?.devices ?? []).filter((d) => d.type === 'expromo-eps').map((d) => ({ id: d.id, label: d.label }))
  }

  updateActions() {
    const presetChoices = this.presetChoices()
    const zoneChoices = this.zoneChoices()
    const epsChoices = this.epsChoices()
    const fallback = (choices, msg) => (choices.length ? choices : [{ id: '', label: msg }])

    this.setActionDefinitions({
      recall_preset: {
        name: 'Recall preset / scene',
        options: [
          {
            type: 'dropdown',
            id: 'target',
            label: 'Preset',
            choices: fallback(presetChoices, '(no presets found — check the connection)'),
            default: presetChoices[0]?.id ?? '',
          },
        ],
        callback: async (event) => {
          const [deviceId, zoneId, presetId] = String(event.options.target).split(':')
          await this.apiFetch(`/api/devices/${deviceId}/zones/${zoneId}/preset`, {
            method: 'POST',
            body: JSON.stringify({ presetId: Number(presetId) }),
          })
        },
      },
      set_brightness: {
        name: 'Set brightness',
        options: [
          {
            type: 'dropdown',
            id: 'zone',
            label: 'Zone',
            choices: fallback(zoneChoices, '(no zones found)'),
            default: zoneChoices[0]?.id ?? '',
          },
          { type: 'number', id: 'brightness', label: 'Brightness %', min: 0, max: 100, default: 50 },
        ],
        callback: async (event) => {
          const [deviceId, zoneId] = String(event.options.zone).split(':')
          await this.apiFetch(`/api/devices/${deviceId}/zones/${zoneId}/brightness`, {
            method: 'POST',
            body: JSON.stringify({ brightness: Number(event.options.brightness) }),
          })
        },
      },
      set_blackout: {
        name: 'Blackout',
        options: [
          {
            type: 'dropdown',
            id: 'zone',
            label: 'Zone',
            choices: fallback(zoneChoices, '(no zones found)'),
            default: zoneChoices[0]?.id ?? '',
          },
          {
            type: 'dropdown',
            id: 'state',
            label: 'Blackout',
            choices: [
              { id: 'on', label: 'On' },
              { id: 'off', label: 'Off' },
              { id: 'toggle', label: 'Toggle' },
            ],
            default: 'toggle',
          },
        ],
        callback: async (event) => {
          const [deviceId, zoneId] = String(event.options.zone).split(':')
          let blackout = event.options.state === 'on'
          if (event.options.state === 'toggle') blackout = !this.findZone(deviceId, zoneId)?.blackout
          await this.apiFetch(`/api/devices/${deviceId}/zones/${zoneId}/blackout`, {
            method: 'POST',
            body: JSON.stringify({ blackout }),
          })
        },
      },
      eps_power: {
        name: 'EPS power',
        options: [
          {
            type: 'dropdown',
            id: 'eps',
            label: 'Power unit',
            choices: fallback(epsChoices, '(no EPS units found)'),
            default: epsChoices[0]?.id ?? '',
          },
          {
            type: 'dropdown',
            id: 'power',
            label: 'Action',
            choices: [
              { id: 'on', label: 'Power on' },
              { id: 'off', label: 'Power off' },
            ],
            default: 'on',
          },
        ],
        callback: async (event) => {
          await this.apiFetch(`/api/power/${event.options.eps}/${event.options.power}`, { method: 'POST' })
        },
      },
    })
  }

  updateFeedbacks() {
    const presetChoices = this.presetChoices()
    const zoneChoices = this.zoneChoices()

    this.setFeedbackDefinitions({
      active_preset: {
        type: 'boolean',
        name: 'Preset is active',
        defaultStyle: { bgcolor: combineRgb(0, 100, 0), color: combineRgb(255, 255, 255) },
        options: [
          {
            type: 'dropdown',
            id: 'target',
            label: 'Preset',
            choices: presetChoices.length ? presetChoices : [{ id: '', label: '(no presets found)' }],
            default: presetChoices[0]?.id ?? '',
          },
        ],
        callback: (feedback) => {
          const [deviceId, zoneId, presetId] = String(feedback.options.target).split(':')
          return this.findZone(deviceId, zoneId)?.activePreset === Number(presetId)
        },
      },
      blackout_active: {
        type: 'boolean',
        name: 'Blackout is on',
        defaultStyle: { bgcolor: combineRgb(200, 0, 0), color: combineRgb(255, 255, 255) },
        options: [
          {
            type: 'dropdown',
            id: 'zone',
            label: 'Zone',
            choices: zoneChoices.length ? zoneChoices : [{ id: '', label: '(no zones found)' }],
            default: zoneChoices[0]?.id ?? '',
          },
        ],
        callback: (feedback) => {
          const [deviceId, zoneId] = String(feedback.options.zone).split(':')
          return !!this.findZone(deviceId, zoneId)?.blackout
        },
      },
    })
  }

  updateVariableDefinitions() {
    const defs = []
    const values = {}
    for (const d of this.state?.devices ?? []) {
      for (const z of d.zones ?? []) {
        if (z.brightness != null) {
          const id = `${d.id}_${z.id}_brightness`
          defs.push({ variableId: id, name: `${d.label} ${z.label} brightness` })
          values[id] = z.brightness
        }
      }
      if (d.type === 'expromo-eps' && d.extra?.system != null) {
        const id = `${d.id}_system`
        defs.push({ variableId: id, name: `${d.label} system status` })
        values[id] = d.extra.system
      }
    }
    this.setVariableDefinitions(defs)
    this.setVariableValues(values)
  }
}

runEntrypoint(ExcontrolInstance, [])
