'use strict';
/* eslint-disable jsdoc/require-param */

const { DeviceManagement } = require('@iobroker/dm-utils');
const { safeId } = require('./util');

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

		for (const device of thermostatDevices) {
			const groupId = String(device.native?.groupId ?? '');
			const thermostatId = String(device.native?.thermostatId ?? '');
			if (!groupId || !thermostatId) {
				continue;
			}

			const groupFolderId = `groups.${safeId(groupId)}`;
			const groupObj = await this.adapter.getObjectAsync(groupFolderId);
			const prefix = this._prefix(groupId, thermostatId);
			const roomTempStateId = `${prefix}.temperature.room`;
			const floorTempStateId = `${prefix}.temperature.floor`;
			const onlineStateId = `${prefix}.online`;
			const heatingStateId = `${prefix}.heating`;

			context.addDevice({
				id: { groupId, thermostatId },
				identifier: `${groupId} / ${thermostatId}`,
				name: { stateId: `${prefix}.thermostatName` },
				model: 'OJ Microline OWD5',
				status: {
					connection: { stateId: onlineStateId, mapping: { true: 'connected', false: 'disconnected' } },
				},
				group: {
					key: `group/${groupId}`,
					name: String(groupObj?.common?.name || `Group ${groupId}`),
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

	/** Writes a control state and returns the latest value from DB. */
	async _writeState(deviceId, suffix, value) {
		const base = this._prefix(deviceId.groupId, deviceId.thermostatId);
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
