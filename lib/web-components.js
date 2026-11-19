'use strict';

// ============================================================================
// Backend side of the web components (admin/webcomponents/*): answers the
// `getThermostats` request of the settings (selectSendTo) with the
// thermostat devices of this instance.
// ============================================================================

/**
 * Thermostat devices of the instance as options of a `selectSendTo`.
 *
 * @param {Pick<ioBroker.Adapter, 'getDevicesAsync' | 'getObjectAsync' | 'namespace'>} adapter adapter instance
 * @returns {Promise<{value: string, label: string}[]>} options; `value` is the full device id
 */
async function getThermostatOptions(adapter) {
	const devices = await adapter.getDevicesAsync();
	/** @type {Map<string, string>} */
	const groupNames = new Map();
	/** @type {{value: string, label: string}[]} */
	const options = [];
	for (const device of devices) {
		const match = String(device._id).match(/^(.+\.groups\.[^.]+)\.thermostats\.([^.]+)$/);
		if (!match) {
			continue;
		}
		const [, groupId, thermostatId] = match;
		if (!groupNames.has(groupId)) {
			const group = await adapter.getObjectAsync(groupId).catch(() => null);
			groupNames.set(groupId, nameOf(group?.common?.name, ''));
		}
		const name = nameOf(device.common?.name, `Thermostat ${thermostatId}`);
		const group = groupNames.get(groupId);
		options.push({ value: device._id, label: group ? `${name} (${group})` : name });
	}
	return options.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * @param {ioBroker.StringOrTranslated | undefined} name object name
 * @param {string} fallback used if empty
 * @returns {string} plain name
 */
function nameOf(name, fallback) {
	if (name && typeof name === 'object') {
		return String(name.en || Object.values(name)[0] || fallback);
	}
	return String(name || fallback);
}

module.exports = { getThermostatOptions };
