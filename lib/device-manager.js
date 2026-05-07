'use strict';
/* eslint-disable jsdoc/require-param */

const { DeviceManagement } = require('@iobroker/dm-utils');
const { safeId } = require('./util');
const GROUP_TO_THERMOSTATS_OFFSET = 2;

/** Device Manager integration for thermostat devices. */
class SchlueterDeviceManagement extends DeviceManagement {
	/** Returns generic instance metadata for the Device Manager. */
	getInstanceInfo() {
		return {
			...super.getInstanceInfo(),
			identifierLabel: {
				en: 'Group / Thermostat',
				de: 'Gruppe / Thermostat',
			},
		};
	}

	/** Loads thermostat devices for the current adapter instance. */
	async loadDevices(context) {
		const devices = await this.adapter.getDevicesAsync();
		const thermostatDevices = devices.filter(d => d._id.includes('.groups.') && d._id.includes('.thermostats.'));
		context.setTotalDevices(thermostatDevices.length);
		const groupNameCache = new Map();

		for (const device of thermostatDevices) {
			const { groupId, thermostatId } = this._extractIds(device);
			if (!groupId || !thermostatId) {
				continue;
			}

			const prefix = this._prefix(groupId, thermostatId);
			const roomTempStateId = `${prefix}.temperature.room`;
			const floorTempStateId = `${prefix}.temperature.floor`;
			const onlineStateId = `${prefix}.online`;
			const heatingStateId = `${prefix}.heating`;
			const dmDeviceId = this._toDeviceId(groupId, thermostatId);
			const groupName = await this._getGroupName(groupId, groupNameCache);

			context.addDevice({
				id: dmDeviceId,
				identifier: `${groupId} / ${thermostatId}`,
				name: { stateId: `${prefix}.thermostatName` },
				model: 'OJ Microline OWD5',
				status: {
					connection: { stateId: onlineStateId, mapping: { true: 'connected', false: 'disconnected' } },
				},
				group: {
					key: `group/${groupId}`,
					name: groupName,
				},
				controls: [
					{
						id: 'online',
						type: 'info',
						label: { en: 'Online', de: 'Online' },
						textTrue: { en: 'Yes', de: 'Ja' },
						textFalse: { en: 'No', de: 'Nein' },
						stateId: onlineStateId,
					},
					{
						id: 'heating',
						type: 'info',
						label: { en: 'Heating', de: 'Heizen' },
						textTrue: { en: 'On', de: 'Ein' },
						textFalse: { en: 'Off', de: 'Aus' },
						stateId: heatingStateId,
					},
					{
						id: 'roomTemp',
						type: 'info',
						label: { en: 'Room', de: 'Raum' },
						unit: '°C',
						stateId: roomTempStateId,
					},
					{
						id: 'floorTemp',
						type: 'info',
						label: { en: 'Floor', de: 'Boden' },
						unit: '°C',
						stateId: floorTempStateId,
					},
					{
						id: 'manualSetpoint',
						type: 'slider',
						label: { en: 'Manual setpoint', de: 'Manueller Sollwert' },
						min: 12,
						max: 35,
						step: 0.5,
						unit: '°C',
						stateId: `${prefix}.apply.manual.setpoint`,
						handler: async (deviceId, _controlId, state) => {
							return await this._writeState(deviceId, 'apply.manual.setpoint', Number(state));
						},
					},
					{
						id: 'applyManual',
						type: 'button',
						icon: 'play',
						label: { en: 'Apply manual', de: 'Manual anwenden' },
						handler: async deviceId => {
							return await this._writeState(deviceId, 'apply.manual.apply', true);
						},
					},
					{
						id: 'comfortSetpoint',
						type: 'slider',
						label: { en: 'Comfort setpoint', de: 'Komfort-Sollwert' },
						min: 12,
						max: 35,
						step: 0.5,
						unit: '°C',
						stateId: `${prefix}.apply.comfort.setpoint`,
						handler: async (deviceId, _controlId, state) => {
							return await this._writeState(deviceId, 'apply.comfort.setpoint', Number(state));
						},
					},
					{
						id: 'applyComfort',
						type: 'button',
						icon: 'play',
						label: { en: 'Apply comfort', de: 'Komfort anwenden' },
						handler: async deviceId => {
							return await this._writeState(deviceId, 'apply.comfort.apply', true);
						},
					},
					{
						id: 'applySchedule',
						type: 'button',
						icon: 'play',
						label: { en: 'Schedule mode', de: 'Zeitplanmodus' },
						handler: async deviceId => {
							return await this._writeState(deviceId, 'apply.schedule.apply', true);
						},
					},
					{
						id: 'applyEco',
						type: 'button',
						icon: 'play',
						label: { en: 'Eco mode', de: 'Eco-Modus' },
						handler: async deviceId => {
							return await this._writeState(deviceId, 'apply.eco.apply', true);
						},
					},
				],
			});
		}
	}

	/** Builds the object path prefix for a thermostat. */
	_prefix(groupId, thermostatId) {
		return `groups.${safeId(groupId)}.thermostats.${safeId(thermostatId)}`;
	}

	/** Creates a deterministic string id for Device Manager. */
	_toDeviceId(groupId, thermostatId) {
		return `${safeId(groupId)}/${safeId(thermostatId)}`;
	}

	/** Parses group/thermostat ids from native fields or object id fallback. */
	_extractIds(device) {
		let groupId = String(device.native?.groupId ?? '');
		let thermostatId = String(device.native?.thermostatId ?? '');
		if (groupId && thermostatId) {
			return { groupId, thermostatId };
		}

		const parts = String(device._id || '').split('.');
		const groupIndex = parts.indexOf('groups');
		const thermostatIndex = parts.indexOf('thermostats');
		// expected path shape: ...groups.<groupId>.thermostats.<thermostatId>
		if (groupIndex !== -1 && thermostatIndex === groupIndex + GROUP_TO_THERMOSTATS_OFFSET) {
			groupId = groupId || String(parts[groupIndex + 1] || '');
			thermostatId = thermostatId || String(parts[thermostatIndex + 1] || '');
		}

		return { groupId, thermostatId };
	}

	/** Resolves and caches group name by group id. */
	async _getGroupName(groupId, groupNameCache) {
		if (groupNameCache.has(groupId)) {
			return groupNameCache.get(groupId);
		}
		const groupFolderId = `groups.${safeId(groupId)}`;
		const groupObj = await this.adapter.getObjectAsync(groupFolderId);
		const name = String(groupObj?.common?.name || `Group ${groupId}`);
		groupNameCache.set(groupId, name);
		return name;
	}

	/** Writes a control state and returns the latest value from DB. */
	async _writeState(deviceId, suffix, value) {
		const match = String(deviceId ?? '').match(/^([^/]+)\/([^/]+)$/);
		if (!match) {
			throw new Error(`Invalid device id format: ${deviceId}. Expected format: groupId/thermostatId`);
		}
		const groupId = match[1];
		const thermostatId = match[2];
		const base = this._prefix(groupId, thermostatId);
		const id = `${base}.${suffix}`;
		await this.adapter.setStateAsync(id, { val: value, ack: false });
		return (
			(await this.adapter.getStateAsync(id)) || {
				val: value,
				ack: false,
				ts: Date.now(),
				lc: Date.now(),
				from: `system.adapter.${this.adapter.namespace}`,
			}
		);
	}
}

module.exports = { SchlueterDeviceManagement };
