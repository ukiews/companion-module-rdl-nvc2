const dgram = require('node:dgram')
const { EventEmitter } = require('node:events')
const { networkInterfaces } = require('node:os')
const { isIPv4 } = require('node:net')
const { parseResponses, buildV2 } = require('./protocol')
const MAX_QUEUED_OPERATIONS = 32
const queueError = (message, code) => Object.assign(new Error(message), { code })

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
		this.paused = false
		this.queue = []
		this.activeOperation = null
		this.drainScheduled = false
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
		if (this.paused && command !== 'QC')
			return Promise.reject(
				queueError('RDL polling and actions are paused for firmware maintenance', 'RDL_MAINTENANCE'),
			)
		return this.attempt(command, match).catch((error) => {
			if (!this.closed && error.message.startsWith('Timeout waiting')) {
				this.cancelQueuedAdjusts('Volume adjustment discarded after a request timeout')
				return this.attempt(command, match).catch((retryError) => {
					if (retryError.message.startsWith('Timeout waiting'))
						this.cancelQueuedAdjusts('Volume adjustment discarded after a request timeout')
					throw retryError
				})
			}
			throw error
		})
	}
	attempt(command, match) {
		if (this.closed || !this.ready) return Promise.reject(new Error('RDL socket is not ready'))
		if (this.paused && command !== 'QC')
			return Promise.reject(
				queueError('RDL polling and actions are paused for firmware maintenance', 'RDL_MAINTENANCE'),
			)
		const description = Buffer.isBuffer(command)
			? `V2 0x${command.readUInt16BE(20).toString(16).padStart(4, '0')}`
			: command
		return new Promise((resolve, reject) => {
			const pending = {
				command,
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
	serial(operation, { kind = 'action', maxAge } = {}) {
		if (this.closed) return Promise.reject(new Error('RDL client closed'))
		if (typeof operation !== 'function' || !['poll', 'adjust', 'mute', 'action', 'maintenance'].includes(kind))
			return Promise.reject(new TypeError('Invalid queued RDL operation'))
		if (this.paused && kind !== 'maintenance')
			return Promise.reject(
				queueError('RDL polling and actions are paused for firmware maintenance', 'RDL_MAINTENANCE'),
			)
		if (maxAge !== undefined && (!Number.isFinite(maxAge) || maxAge < 0))
			return Promise.reject(new TypeError('Invalid queued RDL operation age'))
		if (kind === 'mute') this.cancelQueuedAdjusts('Volume adjustment superseded by mute or toggle')
		if (this.queue.length >= MAX_QUEUED_OPERATIONS && kind !== 'poll') {
			const pollIndex = this.queue.findIndex((entry) => entry.kind === 'poll')
			if (pollIndex >= 0) {
				const [poll] = this.queue.splice(pollIndex, 1)
				poll.reject(queueError('Background poll skipped for a pending action', 'RDL_ACTION_CANCELLED'))
			}
		}
		if (this.queue.length >= MAX_QUEUED_OPERATIONS)
			return Promise.reject(queueError('RDL action queue is full', 'RDL_QUEUE_FULL'))
		const result = new Promise((resolve, reject) => {
			const entry = { operation, kind, expiresAt: maxAge === undefined ? null : Date.now() + maxAge, resolve, reject }
			// State-changing actions stay in invocation order; only idle polling yields.
			const pollIndex = kind === 'poll' ? -1 : this.queue.findIndex((queued) => queued.kind === 'poll')
			if (pollIndex < 0) this.queue.push(entry)
			else this.queue.splice(pollIndex, 0, entry)
		})
		if (!this.drainScheduled) {
			this.drainScheduled = true
			queueMicrotask(() => {
				this.drainScheduled = false
				this.drainQueue()
			})
		}
		return result
	}
	cancelQueuedAdjusts(message) {
		const retained = []
		for (const entry of this.queue) {
			if (entry.kind === 'adjust') entry.reject(queueError(message, 'RDL_ACTION_CANCELLED'))
			else retained.push(entry)
		}
		this.queue = retained
	}
	drainQueue() {
		if (this.closed || this.activeOperation) return
		let entry
		while ((entry = this.queue.shift())) {
			if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
				entry.reject(queueError('Queued RDL action expired', 'RDL_ACTION_EXPIRED'))
				continue
			}
			this.activeOperation = entry
			Promise.resolve()
				.then(() => {
					if (this.closed) throw new Error('RDL client closed')
					if (this.paused && entry.kind !== 'maintenance')
						throw queueError('RDL operation paused for firmware maintenance', 'RDL_MAINTENANCE')
					return entry.operation()
				})
				.then(entry.resolve, entry.reject)
				.finally(() => {
					this.activeOperation = null
					this.drainQueue()
				})
			return
		}
	}
	setPaused(paused) {
		this.paused = Boolean(paused)
		if (!this.paused) return
		for (const pending of [...this.pending]) {
			if (pending.command !== 'QC')
				pending.finish(queueError('RDL request paused for firmware maintenance', 'RDL_MAINTENANCE'))
		}
		for (const entry of this.queue.splice(0))
			entry.reject(queueError('Queued RDL operation paused for firmware maintenance', 'RDL_MAINTENANCE'))
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
		for (const entry of this.queue.splice(0)) entry.reject(new Error('RDL client closed'))
		this.activeOperation?.reject(new Error('RDL client closed'))
		for (const pending of [...this.pending]) pending.finish(new Error('RDL client closed'))
		if (this.socket) {
			try {
				this.socket.close()
			} catch {}
		}
	}
}
module.exports = { RdlClient }
