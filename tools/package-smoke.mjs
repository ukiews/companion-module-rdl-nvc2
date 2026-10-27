// Exercise the actual bundled ESM entrypoint using Companion's API 2 context.
import assert from 'node:assert/strict'
import Instance from '../pkg/rdl-nvc2/main.js'
const result = {}
const context = {
	id: 'package-smoke',
	label: 'RDL',
	_isInstanceContext: true,
	setActionDefinitions: (actions) => {
		result.actions = actions
	},
	setFeedbackDefinitions: (feedbacks) => {
		result.feedbacks = feedbacks
	},
	setVariableDefinitions: (variables) => {
		result.variables = variables
	},
	setVariableValues: (values) => {
		result.values = values
	},
	setPresetDefinitions: (sections, presets) => {
		result.sections = sections
		result.presets = presets
	},
	checkFeedbacks() {},
	updateStatus() {},
}
const instance = new Instance(context)
const host = process.argv[2]
let originalProfile
let originalLevels
try {
	await instance.init({ host: host || '', localAddress: process.argv[3] || '', pollMs: 500 })
	assert.ok(result.actions.profile)
	assert.equal(Object.keys(result.presets).length, 13)
	assert.ok(result.variables.last_confirmed_profile)
	if (host) {
		const deadline = Date.now() + 15000
		while (!result.values.connected && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
		assert.equal(result.values.connected, 1, 'Bundled module must connect and publish levels')
		originalLevels = [result.values.ch1_attenuation, result.values.ch2_attenuation]
		originalProfile = (await instance.client.serial(() => instance.client.queryProfile())).profile
		for (const profile of [1, 2, 3, 4]) {
			await result.actions.profile.callback({ options: { profile } })
			assert.equal(result.values.last_confirmed_profile, profile)
			assert.equal(result.values.active_profile, profile)
			assert.equal((await instance.client.serial(() => instance.client.queryProfile())).profile, profile)
			assert.equal(result.feedbacks.profile.callback({ options: { profile } }), true)
		}
		await result.actions.adjust.callback({ options: { channel: '0', value: -1 } })
		assert.equal(
			result.values.ch1_attenuation,
			originalLevels[0] >= 64 ? originalLevels[0] : Math.min(63, originalLevels[0] + 1),
		)
		assert.equal(result.values.ch2_attenuation, originalLevels[1])
		console.log('Bundled live connection, actions, independent active profile queries and feedback passed')
	}
	console.log('Bundled Companion module smoke test passed')
} finally {
	if (originalLevels) {
		try {
			for (let channel = 0; channel < 2; channel++)
				await instance.control.execute(
					originalLevels[channel] >= 64 ? 'mute' : 'set',
					String(channel),
					originalLevels[channel],
				)
			await instance.control.selectProfile(originalProfile)
			assert.equal(result.values.ch1_attenuation, originalLevels[0])
			assert.equal(result.values.ch2_attenuation, originalLevels[1])
			console.log('Restored original levels and Config', originalProfile)
		} finally {
			await instance.destroy()
		}
	}
	await instance.destroy()
}
