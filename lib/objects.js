/* eslint-disable jsdoc/require-jsdoc */
'use strict';

const { safeId } = require('./util');

// Create or migrate a container object (folder / channel / device).
// If the object already exists with a different type or name it is corrected
// in-place so that existing installations are migrated automatically.
async function ensureContainer(adapter, id, type, name, native = {}) {
	const cur = await adapter.safeGetObject(id);
	if (!cur) {
		await adapter.safeSetObject(id, { type, common: { name }, native });
		return;
	}
	if (cur.type !== type || cur.common?.name !== name) {
		await adapter.safeSetObject(id, {
			...cur,
			type,
			common: { ...(cur.common || {}), name },
		});
	}
}

async function ensureGroupObjects(adapter, group) {
	const groupId = String(group?.GroupId ?? '');
	if (!groupId) {
		return;
	}

	const groupName = String(group?.GroupName || `Group ${groupId}`);
	adapter.groupNameCache[groupId] = groupName;

	const groupDev = `groups.${safeId(groupId)}`;

	// folder (was device) – only one device per tree allowed
	await ensureContainer(adapter, groupDev, 'folder', groupName, { groupId });
	// folder (was channel) – channels may not contain devices
	await ensureContainer(adapter, `${groupDev}.thermostats`, 'folder', 'Thermostats');
}

async function ensureThermostatObjects(adapter, devId, native, thermostatName) {
	// Thermostat is the single device in the hierarchy
	const cur = await adapter.safeGetObject(devId);
	if (!cur) {
		await adapter.safeSetObject(devId, {
			type: 'device',
			common: {
				name: thermostatName,
				icon: '/adapter/schlueter-thermostat/schlueter-thermostat.png',
				statusStates: {
					onlineId: `${devId}.online`,
				},
			},
			native,
		});
	} else if (cur.type !== 'device' || cur.common?.name !== thermostatName) {
		await adapter.safeSetObject(devId, {
			...cur,
			type: 'device',
			common: {
				...(cur.common || {}),
				name: thermostatName,
				icon: '/adapter/schlueter-thermostat/schlueter-thermostat.png',
				statusStates: {
					onlineId: `${devId}.online`,
				},
			},
		});
	}

	const ensureState = async (id, common) => {
		await adapter.safeSetObjectNotExists(id, { type: 'state', common, native: {} });
	};

	// core read-only states (directly under device)
	await ensureState(`${devId}.online`, {
		name: 'Online',
		type: 'boolean',
		role: 'indicator.reachable',
		read: true,
		write: false,
	});
	await ensureState(`${devId}.heating`, {
		name: 'Heating',
		type: 'boolean',
		role: 'indicator.working',
		read: true,
		write: false,
	});
	await ensureState(`${devId}.thermostatName`, {
		name: 'Thermostat name',
		type: 'string',
		role: 'text',
		read: true,
		write: false,
	});

	// temperature channel
	await ensureContainer(adapter, `${devId}.temperature`, 'channel', 'Temperature');
	await ensureState(`${devId}.temperature.room`, {
		name: 'Room temperature',
		type: 'number',
		role: 'value.temperature',
		unit: '°C',
		read: true,
		write: false,
	});
	await ensureState(`${devId}.temperature.floor`, {
		name: 'Floor temperature',
		type: 'number',
		role: 'value.temperature',
		unit: '°C',
		read: true,
		write: false,
	});

	// setpoint channel
	await ensureContainer(adapter, `${devId}.setpoint`, 'channel', 'Setpoints');
	await ensureState(`${devId}.setpoint.manual`, {
		name: 'Manual setpoint',
		type: 'number',
		role: 'value.temperature',
		unit: '°C',
		read: true,
		write: false,
	});
	await ensureState(`${devId}.setpoint.comfort`, {
		name: 'Comfort setpoint',
		type: 'number',
		role: 'value.temperature',
		unit: '°C',
		read: true,
		write: false,
	});

	await ensureState(`${devId}.regulationMode`, {
		name: 'Regulation mode',
		type: 'number',
		role: 'value',
		read: true,
		write: false,
		states: {
			1: 'Schedule',
			2: 'Comfort',
			3: 'Manual',
			4: 'Vacation',
			5: 'Unknown',
			6: 'Frost Protection',
			7: 'Unknown',
			8: 'Boost',
			9: 'Eco',
		},
	});

	// endTime channel + states
	await adapter.safeSetObjectNotExists(`${devId}.endTime`, {
		type: 'channel',
		common: { name: 'End times' },
		native: {},
	});
	await ensureState(`${devId}.endTime.comfort`, {
		name: 'Comfort end time',
		type: 'string',
		role: 'date',
		read: true,
		write: false,
	});
	await ensureState(`${devId}.endTime.boost`, {
		name: 'Boost end time',
		type: 'string',
		role: 'date',
		read: true,
		write: false,
	});

	// vacation channel + states (read-only)
	await adapter.safeSetObjectNotExists(`${devId}.vacation`, {
		type: 'channel',
		common: { name: 'Vacation' },
		native: {},
	});
	await ensureState(`${devId}.vacation.enabled`, {
		name: 'Vacation enabled',
		type: 'boolean',
		role: 'switch',
		read: true,
		write: false,
	});
	await ensureState(`${devId}.vacation.begin`, {
		name: 'Vacation begin day',
		type: 'string',
		role: 'date',
		read: true,
		write: false,
	});
	await ensureState(`${devId}.vacation.end`, {
		name: 'Vacation end day',
		type: 'string',
		role: 'date',
		read: true,
		write: false,
	});
	await ensureState(`${devId}.vacation.temperature`, {
		name: 'Vacation temperature',
		type: 'number',
		role: 'value.temperature',
		unit: '°C',
		read: true,
		write: false,
	});

	// schedule & energy channels
	await adapter.safeSetObjectNotExists(`${devId}.schedule`, {
		type: 'channel',
		common: { name: 'Schedule' },
		native: {},
	});
	await adapter.safeSetObjectNotExists(`${devId}.energy`, {
		type: 'channel',
		common: { name: 'Energy' },
		native: {},
	});
}

async function ensureApplyObjects(adapter, devId) {
	const ensureState = async (id, common) => {
		await adapter.safeSetObjectNotExists(id, { type: 'state', common, native: {} });
	};

	await adapter.safeSetObjectNotExists(`${devId}.apply`, { type: 'channel', common: { name: 'Apply' }, native: {} });

	// schedule
	await ensureContainer(adapter, `${devId}.apply.schedule`, 'folder', 'Schedule mode');
	await ensureState(`${devId}.apply.schedule.apply`, {
		name: 'Apply schedule mode (RegulationMode=1)',
		type: 'boolean',
		role: 'button',
		read: false,
		write: true,
		def: false,
	});

	// comfort
	await ensureContainer(adapter, `${devId}.apply.comfort`, 'folder', 'Comfort mode');
	await ensureState(`${devId}.apply.comfort.setpoint`, {
		name: 'Comfort setpoint',
		type: 'number',
		role: 'level.temperature',
		unit: '°C',
		read: true,
		write: true,
		min: 12,
		max: 35,
	});
	await ensureState(`${devId}.apply.comfort.durationMinutes`, {
		name: 'Comfort duration (minutes)',
		type: 'number',
		role: 'value',
		read: true,
		write: true,
		min: 1,
		max: 24 * 60,
		def: 180,
	});
	await ensureState(`${devId}.apply.comfort.apply`, {
		name: 'Apply comfort mode',
		type: 'boolean',
		role: 'button',
		read: false,
		write: true,
		def: false,
	});

	// manual
	await ensureContainer(adapter, `${devId}.apply.manual`, 'folder', 'Manual mode');
	await ensureState(`${devId}.apply.manual.setpoint`, {
		name: 'Manual setpoint',
		type: 'number',
		role: 'level.temperature',
		unit: '°C',
		read: true,
		write: true,
		min: 12,
		max: 35,
	});
	await ensureState(`${devId}.apply.manual.apply`, {
		name: 'Apply manual mode',
		type: 'boolean',
		role: 'button',
		read: false,
		write: true,
		def: false,
	});

	// boost
	await ensureContainer(adapter, `${devId}.apply.boost`, 'folder', 'Boost mode');
	await ensureState(`${devId}.apply.boost.durationMinutes`, {
		name: 'Boost duration (minutes)',
		type: 'number',
		role: 'value',
		read: true,
		write: true,
		min: 1,
		max: 24 * 60,
		def: 60,
	});
	await ensureState(`${devId}.apply.boost.apply`, {
		name: 'Apply boost mode',
		type: 'boolean',
		role: 'button',
		read: false,
		write: true,
		def: false,
	});

	// eco
	await ensureContainer(adapter, `${devId}.apply.eco`, 'folder', 'Eco mode');
	await ensureState(`${devId}.apply.eco.apply`, {
		name: 'Apply eco mode (RegulationMode=9)',
		type: 'boolean',
		role: 'button',
		read: false,
		write: true,
		def: false,
	});

	// name
	await ensureContainer(adapter, `${devId}.apply.name`, 'folder', 'Thermostat name');
	await ensureState(`${devId}.apply.name.value`, {
		name: 'New thermostat name',
		type: 'string',
		role: 'text',
		read: true,
		write: true,
	});
	await ensureState(`${devId}.apply.name.apply`, {
		name: 'Apply new thermostat name',
		type: 'boolean',
		role: 'button',
		read: true,
		write: true,
		def: false,
	});

	// vacation (write via apply)
	await ensureContainer(adapter, `${devId}.apply.vacation`, 'folder', 'Vacation');
	await ensureState(`${devId}.apply.vacation.enabled`, {
		name: 'Vacation enabled',
		type: 'boolean',
		role: 'switch',
		read: true,
		write: true,
		def: false,
	});
	await ensureState(`${devId}.apply.vacation.begin`, {
		name: 'Vacation begin day (YYYY-MM-DD)',
		type: 'string',
		role: 'date',
		read: true,
		write: true,
	});
	await ensureState(`${devId}.apply.vacation.end`, {
		name: 'Vacation end day (YYYY-MM-DD)',
		type: 'string',
		role: 'date',
		read: true,
		write: true,
	});
	await ensureState(`${devId}.apply.vacation.temperature`, {
		name: 'Vacation temperature',
		type: 'number',
		role: 'level.temperature',
		unit: '°C',
		read: true,
		write: true,
		min: 5,
		max: 35,
	});
	await ensureState(`${devId}.apply.vacation.apply`, {
		name: 'Apply vacation settings',
		type: 'boolean',
		role: 'button',
		read: true,
		write: true,
		def: false,
	});
}

module.exports = {
	ensureContainer,
	ensureGroupObjects,
	ensureThermostatObjects,
	ensureApplyObjects,
};
