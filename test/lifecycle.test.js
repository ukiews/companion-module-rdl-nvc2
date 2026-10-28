const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Nvc2Instance } = require('../src/instance')

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(predicate, message, timeout = 1800) {
	const end = Date.now() + timeout
	while (!predicate()) {
		if (Date.now() >= end) assert.fail(message)
		await delay(5)
	}
}

class FakeClient extends EventEmitter {
	constructor(spec = {}, options = {}) {
		super()
		this.spec = spec
		this.options = options
		this.ready = false
		this.closed = false
		this.calls = { open: 0, close: 0, capabilities: 0, levels: 0, profile: 0 }
		this.tail = Promise.resolve()
	}
	async open() {
		this.calls.open++
		if (this.spec.open) await this.spec.open(this)
		this.ready = true
	}
	close() {
		this.calls.close++
		this.closed = true
		this.ready = false
	}
	setPaused(paused) {
		this.paused = paused
	}
	serial(operation, options = {}) {
		const result = this.tail.then(() => {
			if (this.closed) throw new Error('RDL client closed')
			if (this.paused && options.kind !== 'maintenance') throw new Error('RDL traffic paused')
			return operation()
		})
		this.tail = result.catch(() => {})
		return result
	}
	async queryCapabilities() {
		this.calls.capabilities++
		const result = this.spec.capabilities
			? await this.spec.capabilities(this)
			: { type: 'capabilities', model: 'D-NVC2', firmware: '0.1.30', outputs: 2 }
		this.emit('response', result)
		return result
	}
	async queryLevels() {
		this.calls.levels++
		if (this.spec.levels) await this.spec.levels(this)
		const result = { type: 'levels', levels: [31, 35] }
		this.emit('response', result)
		return result
	}
	async queryProfile() {
		this.calls.profile++
		const result = { type: 'profile', source: 'query', profile: 2 }
		this.emit('response', result)
		return result
	}
}

function fixture(t, specifications = [{}], retryMs = 5) {
	// Prevent a missing injection seam from accidentally opening a real socket.
	assert.equal(typeof Nvc2Instance.prototype.createClient, 'function')
	const state = { values: {}, statuses: [], logs: [], variableCalls: [], feedbackCalls: 0 }
	const context = {
		id: 'lifecycle-test',
		label: 'RDL',
		_isInstanceContext: true,
		setActionDefinitions(value) {
			state.actions = value
		},
		setFeedbackDefinitions() {},
		setVariableDefinitions() {},
		setVariableValues(value) {
			state.variableCalls.push({ ...value })
			Object.assign(state.values, value)
		},
		setPresetDefinitions() {},
		checkFeedbacks() {
			state.feedbackCalls++
		},
		updateStatus(status, message) {
			state.statuses.push({ status, message })
		},
		log(level, message) {
			state.logs.push({ level, message })
		},
	}
	const clients = []
	const instance = new Nvc2Instance(context)
	instance.createClient = (options) => {
		const client = new FakeClient(specifications[clients.length] || {}, options)
		clients.push(client)
		return client
	}
	instance.retryDelay = () => retryMs
	t.after(async () => instance.destroy())
	return { instance, clients, state }
}

test('A transient socket-open failure retries and connects without saving the configuration again', async (t) => {
	const { instance, clients, state } = fixture(t, [
		{
			open: async () => {
				throw new Error('Temporary interface failure')
			},
		},
		{},
	])
	await instance.init({ host: '192.0.2.1', pollMs: 500 })
	await waitFor(() => state.values.connected === 1, 'Socket was not reopened after a transient failure')
	assert.equal(clients.length, 2)
	assert.equal(clients[0].closed, true)
	assert.equal(clients[1].calls.capabilities, 1)
	assert.equal(state.values.ch1_attenuation, 31)
})

test('Destroy cancels a scheduled socket reopen', async (t) => {
	const { instance, clients } = fixture(
		t,
		[
			{
				open: async () => {
					throw new Error('Temporary failure')
				},
			},
		],
		40,
	)
	await instance.init({ host: '192.0.2.1', pollMs: 500 })
	await instance.destroy()
	await delay(80)
	assert.equal(clients.length, 1)
	assert.equal(clients[0].closed, true)
	assert.equal(instance.client, undefined)
	assert.equal(instance.control, undefined)
})

test('A configuration change cancels the old retry and ignores obsolete client responses', async (t) => {
	const { instance, clients, state } = fixture(
		t,
		[
			{
				open: async () => {
					throw new Error('Temporary failure')
				},
			},
			{},
		],
		40,
	)
	await instance.init({ host: '192.0.2.1', pollMs: 500 })
	await instance.configUpdated({ host: '192.0.2.2', pollMs: 500 })
	await waitFor(() => state.values.connected === 1, 'New device did not connect')
	clients[0].emit('response', { type: 'levels', levels: [0, 0] })
	clients[0].emit('response', { type: 'profile', source: 'query', profile: 4 })
	await delay(80)
	assert.equal(clients.length, 2)
	assert.equal(clients[1].options.host, '192.0.2.2')
	assert.equal(state.values.ch1_attenuation, 31)
	assert.equal(state.values.active_profile, 2)
})

test('Recovery refreshes firmware identity without querying capabilities on every healthy poll', async (t) => {
	const { instance, clients, state } = fixture(t, [
		{
			capabilities: async (client) => ({
				type: 'capabilities',
				model: 'D-NVC2',
				firmware: client.calls.capabilities === 1 ? '0.1.27' : '0.1.30',
				outputs: 2,
			}),
			levels: async (client) => {
				if (client.calls.levels === 2) throw new Error('Temporary disconnect')
			},
		},
	])
	await instance.init({ host: '192.0.2.1', pollMs: 500 })
	await waitFor(
		() => state.values.firmware === '0.1.30' && state.values.connected === 1,
		'Identity was not refreshed after recovery',
	)
	const client = clients[0]
	assert.equal(client.calls.capabilities, 2)
	const previousLevels = client.calls.levels
	await waitFor(() => client.calls.levels > previousLevels, 'Healthy polling did not continue')
	assert.equal(client.calls.capabilities, 2)
})

test('A detected bootloader pauses level polling; manual refresh checks identity before resuming', async (t) => {
	let bootloader = true
	const { instance, clients, state } = fixture(t, [
		{
			capabilities: async () => ({
				type: 'capabilities',
				model: bootloader ? 'H743VI-UTX-BOOTLOADER' : 'D-NVC2',
				firmware: bootloader ? '0.1.5' : '0.1.30',
				outputs: bootloader ? 0 : 2,
			}),
		},
	])
	await instance.init({ host: '192.0.2.1', pollMs: 500 })
	await waitFor(() => clients[0]?.calls.capabilities === 1, 'Initial identity was not queried')
	await delay(550)
	assert.equal(clients[0].calls.levels, 0)
	assert.equal(clients[0].calls.profile, 0)
	assert.equal(state.values.connected, 0)
	await state.actions.refresh.callback()
	assert.equal(clients[0].calls.capabilities, 2)
	assert.equal(clients[0].calls.levels, 0)
	assert.equal(clients[0].calls.profile, 0)
	bootloader = false
	await state.actions.refresh.callback()
	await waitFor(() => state.values.connected === 1, 'Manual refresh did not resume normal control')
	assert.equal(clients[0].calls.capabilities, 3)
	assert.ok(clients[0].calls.levels >= 1)
	assert.equal(state.values.firmware, '0.1.30')
})

test('Unchanged replies do not republish variables or feedback, while changed levels still update', async (t) => {
	const { instance, clients, state } = fixture(t)
	await instance.init({ host: '192.0.2.1', pollMs: 500 })
	await waitFor(() => state.values.active_profile === 2, 'Initial status was not published')
	const publications = state.variableCalls.length
	const feedbacks = state.feedbackCalls
	clients[0].emit('response', { type: 'levels', levels: [31, 35] })
	clients[0].emit('response', { type: 'profile', source: 'query', profile: 2 })
	clients[0].emit('response', { type: 'set', channel: 0, attenuation: 31 })
	assert.equal(state.variableCalls.length, publications)
	assert.equal(state.feedbackCalls, feedbacks)
	clients[0].emit('response', { type: 'levels', levels: [32, 35] })
	assert.equal(state.variableCalls.length, publications + 1)
	assert.equal(state.feedbackCalls, feedbacks + 1)
	assert.equal(state.values.ch1_attenuation, 32)
	assert.equal(state.values.ch2_attenuation, 35)
})
