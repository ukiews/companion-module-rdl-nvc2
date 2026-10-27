const { MUTE, setLevel, selectProfile } = require('./protocol')
class VolumeControl {
	constructor(client) {
		this.client = client
		this.saved = [null, null]
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
		return this.client.serial(async () => {
			if (!['set', 'adjust', 'mute', 'unmute', 'toggle'].includes(action)) throw new Error('Unknown volume action')
			if (!['0', '1', 'both'].includes(String(selection))) throw new Error('Invalid channel selection')
			if (['set', 'adjust'].includes(action) && !Number.isInteger(value)) throw new Error('Level must be an integer')
			if (action === 'set' && (value < 0 || value > 63)) throw new Error('Attenuation must be 0 to 63 dB')
			if (action === 'adjust' && Math.abs(value) > 63) throw new Error('Volume adjustment must be -63 to 63 dB')
			const { levels } = await this.client.queryLevels()
			const channels = selection === 'both' ? [0, 1] : [Number(selection)]
			const mode = action === 'toggle' ? (channels.every((c) => levels[c] >= MUTE) ? 'unmute' : 'mute') : action
			// Validate the entire operation before writing either channel.
			if (mode === 'unmute' && channels.some((c) => levels[c] >= MUTE && this.saved[c] === null))
				throw new Error('No saved level for unmute. Use Set attenuation to select a level explicitly.')
			for (const channel of channels) {
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
				const command = setLevel(channel, target)
				await this.client.request(command, (r) => r.type === 'set' && r.channel === channel && r.attenuation === target)
			}
			return this.client.queryLevels()
		})
	}
}
module.exports = { VolumeControl }
