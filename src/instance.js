const { InstanceBase, InstanceStatus, Regex, combineRgb } = require('@companion-module/base')
const { RdlClient } = require('./client')
const { VolumeControl } = require('./control')
const { MUTE } = require('./protocol')
const WHITE = combineRgb(255, 255, 255)
const RED = combineRgb(180, 0, 0)
const LOCK_ENABLED_COLOR = combineRgb(160, 90, 0)
const LOCK_DISABLED_COLOR = combineRgb(0, 80, 160)
const LOCK_POLL_MS = 30000
const channels = [
	{ id: 'both', label: 'Both channels' },
	{ id: '0', label: 'A / Output 1' },
	{ id: '1', label: 'B / Output 2' },
]
const channelOption = () => ({ type: 'dropdown', id: 'channel', label: 'Channel', default: 'both', choices: channels })

class Nvc2Instance extends InstanceBase {
	async init(config) {
		await this.configUpdated(config)
	}
	async destroy() {
		clearTimeout(this.pollTimer)
		clearTimeout(this.reconnectTimer)
		this.generation = (this.generation || 0) + 1
		this.client?.close()
		this.client = undefined
		this.control?.clearRestore()
		this.control = undefined
	}
	getConfigFields() {
		return [
			{ type: 'textinput', id: 'host', label: 'Device IPv4 address', width: 8, default: '', regex: Regex.IP },
			{
				type: 'textinput',
				id: 'localAddress',
				label: 'Local interface IPv4 (blank = all interfaces)',
				width: 12,
				default: '',
			},
			{ type: 'textinput', id: 'group', label: 'Response multicast address', width: 8, default: '239.254.50.0' },
			{ type: 'number', id: 'port', label: 'Response UDP port', width: 4, default: 9000, min: 1, max: 65535 },
			{
				type: 'number',
				id: 'pollMs',
				label: 'Level polling interval (ms)',
				width: 6,
				default: 1000,
				min: 500,
				max: 10000,
			},
			{
				type: 'static-text',
				id: 'help',
				label: 'Network',
				value:
					'Allow multicast replies through the firewall. The module never changes device network settings. Use Set attenuation after a restart if a muted channel has no saved restore level.',
			},
		]
	}
	createClient(options) {
		return new RdlClient(options)
	}
	retryDelay(attempt) {
		return Math.min(10000, 1000 * 2 ** Math.min(attempt, 4))
	}
	async configUpdated(config) {
		await this.destroy()
		this.config = config
		this.levels = [null, null]
		this.connected = false
		this.profile = null
		this.volumeLock = null
		this.nextLockPoll = 0
		this.model = ''
		this.firmware = ''
		this.maintenance = false
		this.needsCapabilities = true
		this.reconnectAttempts = 0
		this.lastPublished = null
		this.defineControls()
		this.publish()
		if (!config.host?.trim()) {
			this.updateStatus(InstanceStatus.BadConfig, 'Enter the device IPv4 address')
			return
		}
		await this.startConnection(config, this.generation)
	}
	unavailable(error) {
		this.connected = false
		this.profile = null
		this.volumeLock = null
		this.nextLockPoll = 0
		this.needsCapabilities = true
		this.control?.clearRestore()
		this.updateStatus(InstanceStatus.ConnectionFailure, error.message)
		this.publish()
	}
	scheduleReconnect(config, generation) {
		if (generation !== this.generation || this.maintenance) return
		clearTimeout(this.pollTimer)
		clearTimeout(this.reconnectTimer)
		this.reconnectTimer = setTimeout(() => {
			if (generation === this.generation) void this.startConnection(config, generation)
		}, this.retryDelay(this.reconnectAttempts++))
	}
	schedulePoll(client, generation, delay) {
		if (generation !== this.generation || client !== this.client || this.maintenance) return
		clearTimeout(this.pollTimer)
		this.pollTimer = setTimeout(() => void this.pollClient(client, generation), delay)
	}
	async startConnection(config, generation) {
		if (generation !== this.generation) return
		let client
		try {
			client = this.createClient({
				host: config.host.trim(),
				group: config.group || '239.254.50.0',
				port: Number(config.port || 9000),
				localAddress: (config.localAddress || '').trim(),
			})
		} catch (error) {
			this.updateStatus(InstanceStatus.BadConfig, error.message)
			return
		}
		this.client = client
		this.control = new VolumeControl(client)
		const current = () => generation === this.generation && client === this.client
		client.on('response', (response) => {
			if (!current()) return
			if (response.type === 'capabilities') {
				const wasPaused = this.maintenance
				const previousModel = this.model
				this.model = response.model
				this.firmware = response.firmware
				this.maintenance = /BOOTLOADER/i.test(response.model)
				client.setPaused(this.maintenance)
				this.needsCapabilities = false
				if (this.maintenance) {
					clearTimeout(this.pollTimer)
					this.connected = false
					this.profile = null
					this.volumeLock = null
					this.nextLockPoll = 0
					this.control.clearRestore()
					this.updateStatus(InstanceStatus.Disconnected, 'Bootloader detected: polling paused; refresh after update')
				} else {
					if (previousModel !== this.model && !/^(D|DB|DS)-NVC2$/.test(this.model))
						this.log('warn', `Unexpected device model: ${this.model}; this module is intended for D-NVC2`)
					if (wasPaused) this.schedulePoll(client, generation, 0)
				}
			}
			if (response.type === 'levels' && !this.maintenance) {
				this.control.observeLevels(response.levels)
				this.levels = response.levels
				this.connected = true
				this.updateStatus(InstanceStatus.Ok)
			}
			if (response.type === 'profile' && response.source === 'query' && !this.maintenance)
				this.profile = response.profile
			if (response.type === 'volumeLock' && response.source === 'query' && !this.maintenance)
				this.volumeLock = response.enabled
			this.publish()
		})
		client.on('warning', (message) => {
			if (current()) this.log('warn', message)
		})
		client.on('fault', (error) => {
			if (!current()) return
			this.unavailable(error)
			if (client.ready) {
				client.close()
				this.client = undefined
				this.control = undefined
				this.scheduleReconnect(config, generation)
			}
		})
		this.updateStatus(InstanceStatus.Connecting)
		try {
			await client.open()
			if (!current()) {
				client.close()
				return
			}
			this.reconnectAttempts = 0
			this.failedPolls = 0
			void this.pollClient(client, generation)
		} catch (error) {
			if (!current()) return
			client.close()
			this.unavailable(error)
			this.client = undefined
			this.control = undefined
			this.scheduleReconnect(config, generation)
		}
	}
	async refreshVolumeLock(client) {
		this.nextLockPoll = Date.now() + LOCK_POLL_MS
		try {
			await client.queryVolumeLock()
		} catch (error) {
			if (client !== this.client || this.maintenance) return
			this.volumeLock = null
			this.publish()
			this.log('debug', error.message)
		}
	}
	async pollClient(client, generation) {
		const current = () => generation === this.generation && client === this.client
		if (!current() || this.maintenance) return
		try {
			await client.serial(
				async () => {
					if (!this.model) {
						try {
							await client.queryCapabilities()
						} catch (error) {
							this.log('debug', error.message)
						}
					}
					if (this.maintenance) return
					await client.queryLevels()
					this.failedPolls = 0
					if (this.needsCapabilities) {
						try {
							await client.queryCapabilities()
						} catch (error) {
							this.log('debug', error.message)
						}
					}
					if (this.maintenance) return
					try {
						await client.queryProfile()
					} catch (error) {
						if (!current()) return
						this.profile = null
						this.publish()
						this.log('debug', error.message)
					}
					if (current() && !this.maintenance && Date.now() >= this.nextLockPoll) await this.refreshVolumeLock(client)
				},
				{ kind: 'poll' },
			)
		} catch (error) {
			if (!current() || this.maintenance) return
			if (['RDL_ACTION_EXPIRED', 'RDL_ACTION_CANCELLED', 'RDL_QUEUE_FULL'].includes(error.code)) {
				this.schedulePoll(client, generation, Math.max(500, Math.min(10000, Number(this.config.pollMs) || 1000)))
				return
			}
			this.unavailable(error)
			if (++this.failedPolls >= 3) {
				client.close()
				this.client = undefined
				this.control = undefined
				this.scheduleReconnect(this.config, generation)
				return
			}
		}
		if (current())
			this.schedulePoll(client, generation, Math.max(500, Math.min(10000, Number(this.config.pollMs) || 1000)))
	}
	publish() {
		const values = {
			connected: this.connected ? 1 : 0,
			model: this.model,
			firmware: this.firmware,
			last_confirmed_profile: this.connected ? (this.profile ?? '') : '',
			active_profile: this.connected ? (this.profile ?? '') : '',
			volume_lock_enabled: this.connected && this.volumeLock != null ? Number(this.volumeLock) : '',
		}
		for (let i = 0; i < 2; i++) {
			const level = this.connected ? this.levels[i] : null
			values[`ch${i + 1}_attenuation`] = level ?? ''
			values[`ch${i + 1}_db`] = level === null ? '' : level >= MUTE ? '-inf' : -level
			values[`ch${i + 1}_muted`] = level === null ? '' : level >= MUTE ? 1 : 0
			values[`ch${i + 1}_display`] = level === null ? 'Unknown' : level >= MUTE ? 'MUTE' : `${-level} dB`
		}
		const changed = Object.fromEntries(
			Object.entries(values).filter(([key, value]) => !this.lastPublished || this.lastPublished[key] !== value),
		)
		if (!Object.keys(changed).length) return
		this.lastPublished = values
		this.setVariableValues(changed)
		this.checkFeedbacks('muted', 'level', 'connected', 'profile')
		if (Object.hasOwn(changed, 'volume_lock_enabled'))
			this.checkFeedbacks('volume_lock_enabled', 'volume_lock_disabled')
	}
	defineControls() {
		const variables = [
			'connected',
			'model',
			'firmware',
			'active_profile',
			'last_confirmed_profile',
			'volume_lock_enabled',
		]
		for (let i = 1; i <= 2; i++) variables.push(`ch${i}_attenuation`, `ch${i}_db`, `ch${i}_muted`, `ch${i}_display`)
		this.setVariableDefinitions(
			Object.fromEntries(variables.map((variableId) => [variableId, { name: variableId.replaceAll('_', ' ') }])),
		)
		const actions = {}
		for (const [id, name] of Object.entries({
			set: 'Set attenuation',
			adjust: 'Adjust volume (+ = louder, - = quieter)',
			mute: 'Mute',
			unmute: 'Restore level before module mute',
			toggle: 'Toggle mute',
		})) {
			const options = [channelOption()]
			if (id === 'set')
				options.push({
					type: 'dropdown',
					id: 'unit',
					label: 'Unit',
					default: 'db',
					disableAutoExpression: true,
					choices: [
						{ id: 'db', label: 'Attenuation (dB)' },
						{ id: 'percent', label: 'Volume (%)' },
					],
				})
			if (id === 'set' || id === 'adjust')
				options.push({
					type: 'number',
					id: 'value',
					label: id === 'set' ? 'Attenuation (dB, 0 = full volume)' : 'Volume change (dB)',
					default: id === 'set' ? 31 : 1,
					min: id === 'set' ? 0 : -63,
					max: 63,
					step: 1,
					...(id === 'set' ? { isVisibleExpression: '$(options:unit) != "percent"' } : {}),
				})
			if (id === 'set')
				options.push({
					type: 'number',
					id: 'percent',
					label: 'Volume (%, 0 = mute)',
					default: 51,
					min: 0,
					max: 100,
					step: 1,
					isVisibleExpression: '$(options:unit) == "percent"',
				})
			actions[id] = {
				name,
				options,
				callback: async (event) => {
					try {
						if (this.maintenance) throw new Error('Polling and control are paused while the bootloader is active')
						if (!this.control || !this.client?.ready) throw new Error('Device is not connected')
						const channel = String(event.options.channel)
						if (id === 'set' && event.options.unit === 'percent')
							await this.control.setPercent(channel, event.options.percent)
						else await this.control.execute(id, channel, Number(event.options.value))
					} catch (error) {
						this.log(
							['RDL_ACTION_EXPIRED', 'RDL_ACTION_CANCELLED', 'RDL_QUEUE_FULL', 'RDL_MAINTENANCE'].includes(error.code)
								? 'debug'
								: 'error',
							error.message,
						)
					}
				},
			}
		}
		actions.refresh = {
			name: 'Refresh device status',
			options: [],
			callback: async () => {
				try {
					const client = this.client
					await client?.serial(
						async () => {
							if (this.maintenance || this.needsCapabilities) await client.queryCapabilities()
							if (this.maintenance) return
							await client.queryLevels()
							await client.queryProfile()
							if (client === this.client && !this.maintenance) await this.refreshVolumeLock(client)
						},
						{ kind: 'maintenance' },
					)
				} catch (error) {
					this.log(
						['RDL_ACTION_EXPIRED', 'RDL_ACTION_CANCELLED', 'RDL_QUEUE_FULL', 'RDL_MAINTENANCE'].includes(error.code)
							? 'debug'
							: 'error',
						error.message,
					)
				}
			},
		}
		const profileOption = () => ({
			type: 'dropdown',
			id: 'profile',
			label: 'Saved RDL Config profile',
			default: 1,
			choices: [1, 2, 3, 4].map((id) => ({ id, label: `Config ${id}` })),
		})
		actions.profile = {
			name: 'Select saved RDL Config profile',
			options: [profileOption()],
			callback: async (event) => {
				try {
					if (this.maintenance) throw new Error('Polling and control are paused while the bootloader is active')
					if (!this.control || !this.client?.ready) throw new Error('Device is not connected')
					await this.control.selectProfile(Number(event.options.profile))
				} catch (error) {
					this.log(
						['RDL_ACTION_EXPIRED', 'RDL_ACTION_CANCELLED', 'RDL_QUEUE_FULL', 'RDL_MAINTENANCE'].includes(error.code)
							? 'debug'
							: 'error',
						error.message,
					)
				}
			},
		}
		actions.volume_lock = {
			name: 'Set physical volume lock',
			options: [
				{
					type: 'dropdown',
					id: 'mode',
					label: 'Automatic volume lock',
					default: 'enable',
					choices: [
						{ id: 'enable', label: 'Enable' },
						{ id: 'disable', label: 'Disable' },
					],
				},
			],
			callback: async ({ options: { mode } }) => {
				const client = this.client
				try {
					if (this.maintenance) throw new Error('Polling and control are paused while the bootloader is active')
					if (!this.control || !client?.ready) throw new Error('Device is not connected')
					if (mode !== 'enable' && mode !== 'disable') throw new Error('Invalid physical volume lock option')
					await this.control.setVolumeLock(mode === 'enable')
				} catch (error) {
					if (client === this.client && !this.maintenance && client?.ready) {
						this.volumeLock = null
						this.nextLockPoll = 0
						this.publish()
					}
					this.log(
						['RDL_ACTION_CANCELLED', 'RDL_QUEUE_FULL', 'RDL_MAINTENANCE'].includes(error.code) ? 'debug' : 'error',
						error.message,
					)
				}
			},
		}
		this.setActionDefinitions(actions)
		const selected = (option) => (option === 'both' ? [0, 1] : [Number(option)])
		this.setFeedbackDefinitions({
			muted: {
				type: 'boolean',
				name: 'Selected channels are all muted',
				defaultStyle: { color: WHITE, bgcolor: RED },
				options: [channelOption()],
				callback: (event) => this.connected && selected(event.options.channel).every((c) => this.levels[c] >= MUTE),
			},
			level: {
				type: 'boolean',
				name: 'Attenuation at least threshold (all selected channels)',
				defaultStyle: { color: WHITE, bgcolor: combineRgb(160, 90, 0) },
				options: [
					channelOption(),
					{ type: 'number', id: 'threshold', label: 'Attenuation threshold (dB)', default: 40, min: 0, max: 64 },
				],
				callback: (event) =>
					this.connected &&
					selected(event.options.channel).every((c) => this.levels[c] >= Number(event.options.threshold)),
			},
			connected: {
				type: 'boolean',
				name: 'Device responding',
				defaultStyle: { color: WHITE, bgcolor: combineRgb(0, 100, 0) },
				options: [],
				callback: () => this.connected,
			},
			profile: {
				type: 'boolean',
				name: 'Active Config profile (device readback)',
				defaultStyle: { color: WHITE, bgcolor: combineRgb(0, 80, 160) },
				options: [profileOption()],
				callback: (event) => this.connected && this.profile === Number(event.options.profile),
			},
			volume_lock_enabled: {
				type: 'boolean',
				name: 'Physical volume lock is enabled',
				defaultStyle: { color: WHITE, bgcolor: LOCK_ENABLED_COLOR },
				options: [],
				callback: () => this.connected && this.volumeLock === true,
			},
			volume_lock_disabled: {
				type: 'boolean',
				name: 'Physical volume lock is disabled',
				defaultStyle: { color: WHITE, bgcolor: LOCK_DISABLED_COLOR },
				options: [],
				callback: () => this.connected && this.volumeLock === false,
			},
		})
		const presets = {}
		for (let profile = 1; profile <= 4; profile++)
			presets[`profile_${profile}`] = {
				type: 'simple',
				category: 'RDL Config profiles',
				name: `Config ${profile}`,
				style: { text: `Config ${profile}`, size: '18', color: WHITE, bgcolor: combineRgb(30, 30, 30) },
				steps: [{ down: [{ actionId: 'profile', options: { profile } }], up: [] }],
				feedbacks: [{ feedbackId: 'profile', options: { profile }, style: { bgcolor: combineRgb(0, 80, 160) } }],
			}
		for (const channel of channels) {
			for (const [id, text, options] of [
				['adjust', 'VOL +', { value: 1 }],
				['adjust', 'VOL -', { value: -1 }],
				['toggle', 'MUTE', {}],
			]) {
				presets[`${channel.id}_${text}`] = {
					type: 'simple',
					category: channel.label,
					name: `${channel.label} ${text}`,
					style: {
						text: `${channel.id === 'both' ? 'A+B' : channel.id === '0' ? 'A' : 'B'} ${text}\n$(self:ch${channel.id === '1' ? 2 : 1}_display)`,
						size: '14',
						color: WHITE,
						bgcolor: combineRgb(30, 30, 30),
					},
					steps: [{ down: [{ actionId: id, options: { channel: channel.id, ...options } }], up: [] }],
					feedbacks: [{ feedbackId: 'muted', options: { channel: channel.id }, style: { bgcolor: RED } }],
				}
			}
		}
		for (const [mode, label, feedbackId, bgcolor] of [
			['enable', 'Enable', 'volume_lock_enabled', LOCK_ENABLED_COLOR],
			['disable', 'Disable', 'volume_lock_disabled', LOCK_DISABLED_COLOR],
		]) {
			presets[`volume_lock_${mode}`] = {
				type: 'simple',
				category: 'Physical volume lock',
				name: `${label} Volume Lock`,
				style: { text: `${label}\nVol Lock`, size: '14', color: WHITE, bgcolor: combineRgb(30, 30, 30) },
				steps: [{ down: [{ actionId: 'volume_lock', options: { mode } }], up: [] }],
				feedbacks: [{ feedbackId, options: {}, style: { bgcolor } }],
			}
		}
		const categories = [...new Set(Object.values(presets).map((p) => p.category))]
		const sections = categories.map((name, index) => ({
			id: `section_${index}`,
			name,
			definitions: Object.entries(presets)
				.filter(([, p]) => p.category === name)
				.map(([id]) => id),
		}))
		for (const preset of Object.values(presets)) delete preset.category
		this.setPresetDefinitions(sections, presets)
	}
}
module.exports = { Nvc2Instance }
