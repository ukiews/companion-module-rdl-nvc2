const MUTE = 64
function selectProfile(profile) {
	if (!Number.isInteger(profile) || profile < 1 || profile > 4) throw new Error('Profile must be 1 to 4')
	return `DISP${profile - 1}`
}
function setLevel(channel, attenuation) {
	if (![0, 1].includes(channel)) throw new Error('Channel must be 0 or 1')
	if (!Number.isInteger(attenuation) || attenuation < 0 || attenuation > MUTE)
		throw new Error('Attenuation must be an integer from 0 to 64')
	return `SL${channel}${String(attenuation).padStart(2, '0')}`
}
function parseResponse(buffer) {
	const text = buffer.toString('ascii').replace(/\0+$/, '')
	if (text.startsWith('NAK')) return { type: 'nak', command: text.slice(3) }
	if (/^ACKDISP[0-3]$/.test(text)) return { type: 'profile', profile: Number(text.slice(7)) + 1 }
	if (text.startsWith('ACKQC')) {
		const fields = text.slice(5).split(':')
		const channels = fields.find((f) => /^CHI\d+O\d+$/.test(f))
		return {
			type: 'capabilities',
			model: fields[0],
			firmware: fields.find((f) => /^V/.test(f))?.slice(1) || '',
			outputs: channels ? Number(channels.match(/O(\d+)/)[1]) : 0,
		}
	}
	if (text.startsWith('ACKQL')) {
		const body = text.slice(5)
		if (!/^C1-0\d{2}C2-0\d{2}$/.test(body)) return null
		const levels = [...body.matchAll(/C\d-0(\d{2})/g)].map((m) => Number(m[1]))
		if (levels.some((v) => v > 99)) return null
		return { type: 'levels', levels }
	}
	if (/^ACKSL[01]\d{2}$/.test(text))
		return { type: 'set', channel: Number(text[5]), attenuation: Number(text.slice(6)) }
	return null
}
module.exports = { MUTE, setLevel, selectProfile, parseResponse }
