const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Nvc2Instance } = require('../src/instance')
function fixture() {
	const state = {}
	const context = {
		id: 'test',
		label: 'RDL',
		_isInstanceContext: true,
		setActionDefinitions: (value) => {
			state.actions = value
		},
		setFeedbackDefinitions: (value) => {
			state.feedbacks = value
		},
		setVariableDefinitions: (value) => {
			state.variables = value
		},
		setVariableValues: (value) => {
			state.values = { ...state.values, ...value }
		},
		setPresetDefinitions: (sections, presets) => {
			state.sections = sections
			state.presets = presets
		},
		checkFeedbacks() {},
		updateStatus: (value) => {
			state.status = value
		},
	}
	return { instance: new Nvc2Instance(context), state }
}
test('Actual Companion API 2 accepts definitions and structured presets', async () => {
	const { instance, state } = fixture()
	await instance.init({ host: '' })
	assert.ok(!Array.isArray(state.variables))
	assert.ok(state.variables.ch1_db)
	assert.equal(Object.keys(state.presets).length, 13)
	assert.equal(state.sections.flatMap((s) => s.definitions).length, 13)
	for (const preset of Object.values(state.presets)) {
		assert.equal(preset.type, 'simple')
		for (const action of preset.steps[0].down) assert.ok(state.actions[action.actionId])
		for (const feedback of preset.feedbacks) assert.ok(state.feedbacks[feedback.feedbackId])
	}
	assert.equal(state.values.connected, 0)
	assert.equal(state.values.ch1_display, 'Unknown')
	await instance.destroy()
})
test('Live levels and disconnection produce honest variables and feedback', async () => {
	const { instance, state } = fixture()
	await instance.init({ host: '' })
	instance.connected = true
	instance.levels = [63, 64]
	instance.profile = 3
	instance.publish()
	assert.equal(state.values.ch1_db, -63)
	assert.equal(state.values.ch2_db, '-inf')
	assert.equal(state.values.ch1_muted, 0)
	assert.equal(state.values.ch2_muted, 1)
	assert.equal(state.feedbacks.profile.callback({ options: { profile: 3 } }), true)
	instance.connected = false
	instance.publish()
	assert.equal(state.values.last_confirmed_profile, '')
	assert.equal(state.values.ch2_attenuation, '')
	assert.equal(state.feedbacks.muted.callback({ options: { channel: 'both' } }), false)
	await instance.destroy()
})
test('Reconfiguration closes old client, clears timers and restore/profile state', async () => {
	const { instance, state } = fixture()
	let closed = false
	instance.client = {
		close() {
			closed = true
		},
	}
	instance.profile = 3
	await instance.configUpdated({ host: '' })
	assert.equal(closed, true)
	assert.equal(instance.client, undefined)
	assert.equal(instance.profile, null)
	assert.equal(state.values.last_confirmed_profile, '')
	await instance.destroy()
})
