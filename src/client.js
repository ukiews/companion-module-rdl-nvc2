const dgram = require('node:dgram')
const { EventEmitter } = require('node:events')
const { networkInterfaces } = require('node:os')
const { isIPv4 } = require('node:net')
const { parseResponses, buildV2 } = require('./protocol')

class RdlClient extends EventEmitter {
	constructor({ host, group = '239.254.50.0', port = 9000, localAddress = '', timeout = 1500 }) {
		super()
		if (!isIPv4(host)) throw new Error('Device address must be an IPv4 address')
		if (!isIPv4(group) || Number(group.split('.')[0]) < 224 || Number(group.split('.')[0]) > 239)
			throw new Error('Invalid multicast group')
		if (localAddress && !isIPv4(localAddress)) throw new Error('Invalid local IPv4 address')
		if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid response port')
		Object.assign(this, { host, group, port, localAddress, timeout })
		this.pending = new Set()
		this.closed = false
		this.ready = false
		this.tail = Promise.resolve()
	}
	async open() {
		this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
		this.socket.on('message', (data, remote) => {
			if (remote.address !== this.host) return
			for (const response of parseResponses(data)) {
				this.emit('response', response)
				for (const pending of [...this.pending]) {
					if (pending.match(response)) pending.finish(null, response)
				}
			}
		})
		this.socket.on('error', (error) => {
			for (const pending of [...this.pending]) pending.finish(error)
			this.emit('fault', error)
		})
		await new Promise((resolve, reject) => {
			this.socket.once('error', reject)
			this.socket.bind(this.port, '0.0.0.0', () => {
				this.socket.removeListener('error', reject)
				try {
					const addresses = this.localAddress
						? [this.localAddress]
						: [
								...new Set(
									Object.values(networkInterfaces())
										.flat()
										.filter((i) => i && i.family === 'IPv4' && !i.internal)
										.map((i) => i.address),
								),
							]
					let joined = 0
					for (const address of addresses) {
						try {
							this.socket.addMembership(this.group, address)
							joined++
						} catch (error) {
							this.emit('warning', `Cannot join multicast on ${address}: ${error.message}`)
						}
					}
					if (!joined) throw new Error('Could not join multicast group on any network interface')
					this.ready = true
					resolve()
				} catch (error) {
					reject(error)
				}
			})
		})
	}
	request(command, match) {
		if (this.closed || !this.ready) return Promise.reject(new Error('RDL socket is not ready'))
		return this.attempt(command, match).catch((error) => {
			if (!this.closed && error.message.startsWith('Timeout waiting')) return this.attempt(command, match)
			throw error
		})
	}
	attempt(command, match) {
		const description = Buffer.isBuffer(command)
			? `V2 0x${command.readUInt16BE(20).toString(16).padStart(4, '0')}`
			: command
		return new Promise((resolve, reject) => {
			const pending = {
				match: (r) => (r.type === 'nak' && r.command === command) || match(r),
				finish: (error, response) => {
					if (!this.pending.delete(pending)) return
					clearTimeout(timer)
					if (error) reject(error)
					else if (response.type === 'nak') reject(new Error(`Device rejected ${description}`))
					else resolve(response)
				},
			}
			const timer = setTimeout(() => pending.finish(new Error(`Timeout waiting for ${description}`)), this.timeout)
			this.pending.add(pending)
			this.socket.send(Buffer.from(command, 'ascii'), 18700, this.host, (error) => {
				if (error) pending.finish(error)
			})
		})
	}
	serial(operation) {
		const result = this.tail.then(() => {
			if (this.closed) throw new Error('RDL client closed')
			return operation()
		})
		this.tail = result.catch(() => {})
		return result
	}
	queryLevels() {
		return this.request('QL', (r) => r.type === 'levels')
	}
	queryCapabilities() {
		return this.request('QC', (r) => r.type === 'capabilities')
	}
	queryProfile() {
		return this.request(buildV2(0x0501), (r) => r.type === 'profile' && r.source === 'query')
	}
	close() {
		this.closed = true
		this.ready = false
		for (const pending of [...this.pending]) pending.finish(new Error('RDL client closed'))
		if (this.socket) {
			try {
				this.socket.close()
			} catch {}
		}
	}
}
module.exports = { RdlClient }
