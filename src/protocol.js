const MUTE = 64
const PROFILE_NUMBERS = [1, 2, 3, 4]
const VOLUME_LOCK_PROPERTY = 0x0300
const QUERY_PROPERTIES = 0x0104
const SET_PROPERTY = 0x0105

function setVolumeLock(enabled) {
	if (typeof enabled !== 'boolean') throw new TypeError('Volume lock must be enabled or disabled')
	const data = Buffer.alloc(5)
	data.writeUInt16BE(VOLUME_LOCK_PROPERTY, 0)
	data.writeUInt16BE(1, 2)
	data[4] = Number(enabled)
	return buildV2(SET_PROPERTY, data)
}

function selectProfile(profile) {
	if (!PROFILE_NUMBERS.includes(profile)) throw new Error('Profile must be 1 to 4')
	return buildV2(0x0500, Buffer.from([profile - 1]))
}

function buildProfileNamesQuery(firmware) {
	const [major, minor, patch] = firmware.split('.').map(Number)
	// RDL reports both 0.3.00 and 3.x-style versions. The 2.x firmware line added the bulk query.
	const version = major === 0 && patch !== undefined ? minor : major
	return version >= 2
		? buildV2(0x050b)
		: buildV2Frames(PROFILE_NUMBERS.map((profile) => [0x0503, Buffer.from([0, profile - 1])]))
}

function buildV2(command, data = Buffer.alloc(0)) {
	return buildV2Frames([[command, data]])
}

function buildV2Frames(frames) {
	const packet = Buffer.alloc(20 + frames.reduce((length, [, data]) => length + 4 + data.length, 0))
	packet.write('V2', 0, 'ascii')
	packet[2] = frames.length
	packet.writeUInt16BE(packet.length, 8)
	let offset = 20
	for (const [command, data] of frames) {
		packet.writeUInt16BE(command, offset)
		packet.writeUInt16BE(4 + data.length, offset + 2)
		data.copy(packet, offset + 4)
		offset += 4 + data.length
	}
	return packet
}

function decodeProfileName(profile, data, start, end) {
	const name = data.toString('utf8', start, end).split('\0', 1)[0].trim()
	return { type: 'profileName', profile, name }
}

function parseProfileNames(buffer, start, end, command) {
	if (command === 0x8503 && end - start === 34 && buffer.readUInt16BE(start) < PROFILE_NUMBERS.length)
		return [decodeProfileName(buffer.readUInt16BE(start) + 1, buffer, start + 2, end)]

	const names = []
	for (let offset = start; offset < end;) {
		if (offset + 4 > end) return []
		const property = buffer.readUInt16BE(offset)
		const length = buffer.readUInt16BE(offset + 2)
		offset += 4
		if (offset + length > end) return []
		if (property === 0x0312 && length > 0 && buffer[offset] < PROFILE_NUMBERS.length)
			names.push(decodeProfileName(buffer[offset] + 1, buffer, offset + 1, offset + length))
		offset += length
	}
	return names
}
function parseVolumeLock(buffer, start, end, source) {
	let enabled = null
	for (let offset = start; offset < end;) {
		if (offset + 4 > end) return null
		const id = buffer.readUInt16BE(offset)
		const length = buffer.readUInt16BE(offset + 2)
		offset += 4
		if (offset + length > end) return null
		if (id === VOLUME_LOCK_PROPERTY) {
			if (enabled !== null || length !== 1 || buffer[offset] > 1) return null
			enabled = buffer[offset] === 1
		}
		offset += length
	}
	if (source === 'set' && enabled === null) return null
	return { type: 'volumeLock', source, enabled }
}

function parseV2Responses(buffer) {
	if (buffer.length < 24 || buffer.readUInt16BE(8) !== buffer.length) return []
	const responses = []
	let offset = 20
	for (let frame = 0; frame < buffer[2]; frame++) {
		if (offset + 4 > buffer.length) return []
		const command = buffer.readUInt16BE(offset)
		const length = buffer.readUInt16BE(offset + 2)
		if (length < 4 || offset + length > buffer.length) return []
		if ((command === 0x8500 || command === 0x8501) && length === 5 && buffer[offset + 4] < PROFILE_NUMBERS.length) {
			responses.push({ type: 'profile', source: command === 0x8501 ? 'query' : 'set', profile: buffer[offset + 4] + 1 })
		}
		if (command === 0x8503 || command === 0x850b)
			responses.push(...parseProfileNames(buffer, offset + 4, offset + length, command))
		if (command === (0x8000 | QUERY_PROPERTIES) || command === (0x8000 | SET_PROPERTY)) {
			const source = command === (0x8000 | QUERY_PROPERTIES) ? 'query' : 'set'
			const response = parseVolumeLock(buffer, offset + 4, offset + length, source)
			if (response) responses.push(response)
		}
		offset += length
	}
	return offset === buffer.length ? responses : []
}
function parseResponses(buffer) {
	if (buffer.subarray(0, 2).equals(Buffer.from('V2'))) return parseV2Responses(buffer)
	const response = parseResponse(buffer)
	return response ? [response] : []
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
module.exports = {
	MUTE,
	PROFILE_NUMBERS,
	QUERY_PROPERTIES,
	setLevel,
	selectProfile,
	setVolumeLock,
	buildV2,
	buildProfileNamesQuery,
	parseResponse,
	parseResponses,
}
