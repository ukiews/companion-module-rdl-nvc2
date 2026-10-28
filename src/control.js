const { MUTE, setLevel, selectProfile } = require('./protocol')
class VolumeControl {
	constructor(client) {
		this.client = client
		this.saved = [null, null]
		this.pendingMute = new Set()
		this.observedLevels = [null, null]
		this.observation = 0
		this.restoreEpoch = 0
	}
	clearRestore() {
		this.restoreEpoch++
		this.saved = [null, null]
		this.pendingMute.clear()
	}
	observeLevels(levels) {
		this.observation++
		for (let channel = 0; channel < 2; channel++) {
			const level = levels?.[channel]
			this.observedLevels[channel] = level
			if (!Number.isInteger(level) || (level < MUTE && !this.pendingMute.has(channel))) this.saved[channel] = null
		}
	}
	async queryLevels() {
		const response = await this.client.queryLevels()
		this.observeLevels(response.levels)
		return response
	}
	selectProfile(profile) {
		const command = selectProfile(profile)
		return this.client.serial(async () => {
			const before = await this.client.queryProfile()
			if (before.profile === profile) return before
			try {
				await this.client.request(command, (r) => r.type === 'profile' && r.source === 'set' && r.profile === profile)
			} catch (error) {
				if (!error.message.startsWith('Timeout waiting')) throw error
				// Firmware can omit an ACK after a retry selects an already active profile.
				const actual = await this.client.queryProfile()
				if (actual.profile === profile) return actual
				throw error
			}
			const actual = await this.client.queryProfile()
			if (actual.profile !== profile)
				throw new Error(`Config readback mismatch: selected ${profile}, device reports ${actual.profile}`)
			return actual
		})
	}
	execute(action, selection, value) {
		const expires = action === 'adjust' ? Date.now() + 1000 : null
		const kind = action === 'adjust' ? 'adjust' : ['mute', 'toggle'].includes(action) ? 'mute' : 'action'
		return this.client.serial(
			async () => {
				if (!['set', 'adjust', 'mute', 'unmute', 'toggle'].includes(action)) throw new Error('Unknown volume action')
				if (!['0', '1', 'both'].includes(String(selection))) throw new Error('Invalid channel selection')
				if (['set', 'adjust'].includes(action) && !Number.isInteger(value)) throw new Error('Level must be an integer')
				if (action === 'set' && (value < 0 || value > 63)) throw new Error('Attenuation must be 0 to 63 dB')
				if (action === 'adjust' && Math.abs(value) > 63) throw new Error('Volume adjustment must be -63 to 63 dB')
				const epoch = this.restoreEpoch
				const { levels } = await this.queryLevels()
				const checkCurrent = (checkAge = true) => {
					if (epoch !== this.restoreEpoch)
						throw Object.assign(new Error('Control operation cancelled after connection state changed'), {
							code: 'RDL_ACTION_CANCELLED',
						})
					if (checkAge && expires !== null && Date.now() >= expires)
						throw Object.assign(new Error('Volume adjustment expired while waiting for the device'), {
							code: 'RDL_ACTION_EXPIRED',
						})
				}
				checkCurrent()
				const channels = selection === 'both' ? [0, 1] : [Number(selection)]
				const mode = action === 'toggle' ? (channels.every((c) => levels[c] >= MUTE) ? 'unmute' : 'mute') : action
				// Validate the entire operation before writing either channel.
				if (mode === 'unmute' && channels.some((c) => levels[c] >= MUTE && this.saved[c] === null))
					throw new Error('No saved level for unmute. Use Set attenuation to select a level explicitly.')
				if (mode === 'set') for (const channel of channels) this.saved[channel] = null
				const targets = new Map()
				const attempted = new Map()
				let readbackAttempted = false
				try {
					for (const channel of channels) {
						checkCurrent(attempted.size === 0)
						const current = levels[channel]
						let target = current
						if (mode === 'set') target = value
						if (mode === 'adjust') {
							if (current >= MUTE) continue // Adjustment must not unexpectedly unmute.
							target = Math.max(0, Math.min(63, current - value))
						}
						if (mode === 'mute') {
							if (current < MUTE) this.saved[channel] = current
							target = MUTE
						}
						if (mode === 'unmute' && current >= MUTE) target = this.saved[channel]
						if (target === current) continue
						targets.set(channel, target)
						attempted.set(channel, this.observation)
						if (mode === 'mute') this.pendingMute.add(channel)
						readbackAttempted = false
						const command = setLevel(channel, target)
						try {
							await this.client.request(
								command,
								(r) => r.type === 'set' && r.channel === channel && r.attenuation === target,
							)
						} catch (error) {
							if (!error.message.startsWith('Timeout waiting')) throw error
							readbackAttempted = true
							const actual = await this.queryLevels()
							if (actual.levels[channel] !== target) throw error
						}
						this.pendingMute.delete(channel)
					}
					readbackAttempted = true
					const actual = await this.queryLevels()
					checkCurrent(false)
					for (const [channel, target] of targets) {
						if (actual.levels[channel] !== target)
							throw new Error(
								`Level readback mismatch on channel ${channel + 1}: requested ${target}, device reports ${actual.levels[channel]}`,
							)
					}
					if (mode === 'unmute') for (const channel of channels) this.saved[channel] = null
					return actual
				} catch (error) {
					if (epoch === this.restoreEpoch) {
						if (attempted.size && !readbackAttempted) {
							try {
								await this.queryLevels()
							} catch {}
						}
						for (const [channel, before] of attempted) {
							if (this.observation <= before || this.observedLevels[channel] < MUTE) this.saved[channel] = null
						}
					}
					throw error
				} finally {
					for (const channel of attempted.keys()) this.pendingMute.delete(channel)
				}
			},
			{ kind, ...(expires === null ? {} : { maxAge: 1000 }) },
		)
	}
}
module.exports = { VolumeControl }
