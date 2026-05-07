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
			smallCards: false,
		};
	}

	/** Loads thermostat devices for the current adapter instance. */
	async loadDevices(context) {
		const devices = await this.adapter.getDevicesAsync();
		const thermostatDevices = devices.filter(d => d._id.includes('.groups.') && d._id.includes('.thermostats.'));
		const addableDevices = thermostatDevices
			.map(device => ({ device, ids: this._extractIds(device) }))
			.filter(({ ids }) => !!ids.groupId && !!ids.thermostatId);
		context.setTotalDevices(addableDevices.length);
		const groupNameCache = new Map();

		for (const { device, ids } of addableDevices) {
			const { groupId, thermostatId } = ids;
			const dmDeviceId = this._toDeviceId(groupId, thermostatId);
			const groupName = await this._getGroupName(groupId, groupNameCache);
			const thermostatName = String(device.common?.name || `Thermostat ${thermostatId}`);

			context.addDevice({
				id: dmDeviceId,
				name: thermostatName,
				icon: `/adapter/${this.adapter.name}/schlueter-thermostat.png`,
				status: {
					connection: {
						stateId: `${this.adapter.namespace}.${this._prefix(groupId, thermostatId)}.online`,
						mapping: { true: 'connected', false: 'disconnected' },
					},
				},
				controls: [
					{
						id: 'online',
						type: 'icon',
						stateId: `${this.adapter.namespace}.${this._prefix(groupId, thermostatId)}.online`,
						icon: 'warning',
						iconOn: 'web',
						label: { en: 'Offline', de: 'Offline' },
						labelOn: { en: 'Online', de: 'Online' },
						color: '#9e9e9e',
						colorOn: '#4caf50',
					},
					{
						id: 'heating',
						type: 'icon',
						stateId: `${this.adapter.namespace}.${this._prefix(groupId, thermostatId)}.heating`,
						icon: 'pause',
						iconOn: 'play',
						label: { en: 'Heating off', de: 'Heizen aus' },
						labelOn: { en: 'Heating on', de: 'Heizen an' },
						color: '#9e9e9e',
						colorOn: '#ff9800',
					},
					{
						id: 'regulationMode',
						type: 'select',
						stateId: `${this.adapter.namespace}.${this._prefix(groupId, thermostatId)}.regulationMode`,
						label: { en: 'Mode', de: 'Modus' },
						options: [
							{ value: 1, label: { en: 'Schedule', de: 'Zeitplan' }, icon: 'lines', color: '#1976d2' },
							{ value: 2, label: { en: 'Comfort', de: 'Komfort' }, icon: 'light', color: '#ff9800' },
							{ value: 3, label: { en: 'Manual', de: 'Manuell' }, icon: 'edit', color: '#9c27b0' },
							{ value: 6, label: { en: 'Boost', de: 'Boost' }, icon: 'play', color: '#f44336' },
							{ value: 8, label: { en: 'Vacation', de: 'Urlaub' }, icon: 'book', color: '#00acc1' },
							{ value: 9, label: { en: 'Eco', de: 'Eco' }, icon: 'dimmer', color: '#4caf50' },
						],
						noTranslation: false,
						color: '#607d8b',
					},
				],
				actions: [],
				hasDetails: true,
				customInfo: {
					id: `card/${dmDeviceId}`,
					schema: {
						type: 'panel',
						items: {
							roomTemperature: {
								type: 'state',
								oid: `${this._prefix(groupId, thermostatId)}.temperature.room`,
								label: { en: 'Room temperature', de: 'Raumtemperatur' },
								unit: '°C',
								newLine: true,
							},
							floorTemperature: {
								type: 'state',
								oid: `${this._prefix(groupId, thermostatId)}.temperature.floor`,
								label: { en: 'Floor temperature', de: 'Bodentemperatur' },
								unit: '°C',
								newLine: true,
							},
						},
					},
				},
				group: {
					key: `group/${groupId}`,
					name: groupName,
				},
			});
		}
	}

	/**
	 * Returns settings form schema for the device details view.
	 *
	 * @param {string} deviceId device id in `groupId/thermostatId` format
	 */
	getDeviceDetails(deviceId) {
		const ids = this._parseDeviceId(deviceId);
		if (!ids) {
			return { id: deviceId, schema: this._emptyDetailsSchema() };
		}
		const prefix = this._prefix(ids.groupId, ids.thermostatId);
		const id = `${this.adapter.namespace}.${prefix}`;
		return {
			id: deviceId,
			schema: this._detailsSchema(prefix, id, ids.groupId, ids.thermostatId),
		};
	}

	/** @returns {import('@iobroker/dm-utils').JsonFormSchema} empty details schema */
	_emptyDetailsSchema() {
		return { type: 'panel', items: {} };
	}

	/** @returns {import('@iobroker/dm-utils').JsonFormSchema} thermostat details schema */
	_detailsSchema(prefix, id, groupId, thermostatId) {
		return {
			type: 'tabs',
			items: {
				info: {
					type: 'panel',
					label: { en: 'Information', de: 'Informationen' },
					items: {
						groupId: {
							type: 'staticInfo',
							label: { en: 'Group', de: 'Gruppe' },
							data: groupId,
							addColon: true,
							newLine: true,
						},
						thermostatId: {
							type: 'staticInfo',
							label: { en: 'Thermostat', de: 'Thermostat' },
							data: thermostatId,
							addColon: true,
							newLine: true,
						},
						model: {
							type: 'staticInfo',
							label: { en: 'Model', de: 'Modell' },
							data: 'OJ Microline OWD5',
							addColon: true,
							newLine: true,
						},
						online: {
							type: 'state',
							oid: `${prefix}.online`,
							label: { en: 'Online', de: 'Online' },
							trueText: { en: 'Connected', de: 'Verbunden' },
							falseText: { en: 'Disconnected', de: 'Getrennt' },
							newLine: true,
						},
						heating: {
							type: 'state',
							oid: `${prefix}.heating`,
							label: { en: 'Heating', de: 'Heizen' },
							trueText: { en: 'On', de: 'An' },
							falseText: { en: 'Off', de: 'Aus' },
							newLine: true,
						},
						roomTemperature: {
							type: 'state',
							oid: `${prefix}.temperature.room`,
							label: { en: 'Room temperature', de: 'Raumtemperatur' },
							unit: '°C',
							newLine: true,
						},
						floorTemperature: {
							type: 'state',
							oid: `${prefix}.temperature.floor`,
							label: { en: 'Floor temperature', de: 'Bodentemperatur' },
							unit: '°C',
							newLine: true,
						},
					},
				},
				controls: {
					type: 'panel',
					label: { en: 'Controls', de: 'Steuerung' },
					items: {
						manualSetpoint: {
							type: 'state',
							oid: `${prefix}.apply.manual.setpoint`,
							label: { en: 'Manual setpoint (°C)', de: 'Manueller Sollwert (°C)' },
							control: 'number',
							min: 12,
							max: 35,
							step: 0.5,
							controlled: true,
							readOnly: false,
							showEnterButton: true,
							setOnEnterKey: true,
						},
						applyManual: {
							type: 'setState',
							id: `${id}.apply.manual.apply`,
							label: { en: 'Apply manual mode', de: 'Manuellen Modus anwenden' },
							val: true,
							variant: 'contained',
							color: 'primary',
						},
						comfortSetpoint: {
							type: 'state',
							oid: `${prefix}.apply.comfort.setpoint`,
							label: { en: 'Comfort setpoint (°C)', de: 'Komfort-Sollwert (°C)' },
							control: 'number',
							min: 12,
							max: 35,
							step: 0.5,
							controlled: true,
							readOnly: false,
							showEnterButton: true,
							setOnEnterKey: true,
						},
						comfortDuration: {
							type: 'state',
							oid: `${prefix}.apply.comfort.durationMinutes`,
							label: { en: 'Comfort duration (min)', de: 'Komfort-Dauer (Min)' },
							control: 'number',
							min: 1,
							max: 1440,
							step: 1,
							controlled: true,
							readOnly: false,
							showEnterButton: true,
							setOnEnterKey: true,
						},
						applyComfort: {
							type: 'setState',
							id: `${id}.apply.comfort.apply`,
							label: { en: 'Apply comfort mode', de: 'Komfortmodus anwenden' },
							val: true,
							variant: 'contained',
							color: 'primary',
						},
						applySchedule: {
							type: 'setState',
							id: `${id}.apply.schedule.apply`,
							label: { en: 'Activate schedule mode', de: 'Zeitplanmodus aktivieren' },
							val: true,
							variant: 'contained',
							color: 'primary',
						},
						applyEco: {
							type: 'setState',
							id: `${id}.apply.eco.apply`,
							label: { en: 'Activate eco mode', de: 'Eco-Modus aktivieren' },
							val: true,
							variant: 'contained',
							color: 'primary',
						},
						boostDuration: {
							type: 'state',
							oid: `${prefix}.apply.boost.durationMinutes`,
							label: { en: 'Boost duration (min)', de: 'Boost-Dauer (Min)' },
							control: 'number',
							min: 1,
							max: 1440,
							step: 1,
							controlled: true,
							readOnly: false,
							showEnterButton: true,
							setOnEnterKey: true,
						},
						applyBoost: {
							type: 'setState',
							id: `${id}.apply.boost.apply`,
							label: { en: 'Activate boost mode', de: 'Boost-Modus aktivieren' },
							val: true,
							variant: 'contained',
							color: 'primary',
						},
						vacationEnabled: {
							type: 'state',
							oid: `${prefix}.apply.vacation.enabled`,
							label: { en: 'Vacation enabled', de: 'Urlaub aktiviert' },
							control: 'switch',
						},
						vacationBegin: {
							type: 'state',
							oid: `${prefix}.apply.vacation.begin`,
							label: { en: 'Vacation begin (YYYY-MM-DD)', de: 'Urlaubsbeginn (JJJJ-MM-TT)' },
							control: 'input',
						},
						vacationEnd: {
							type: 'state',
							oid: `${prefix}.apply.vacation.end`,
							label: { en: 'Vacation end (YYYY-MM-DD)', de: 'Urlaubsende (JJJJ-MM-TT)' },
							control: 'input',
						},
						vacationTemperature: {
							type: 'state',
							oid: `${prefix}.apply.vacation.temperature`,
							label: { en: 'Vacation temperature (°C)', de: 'Urlaubstemperatur (°C)' },
							control: 'number',
							min: 5,
							max: 35,
							step: 0.5,
							controlled: true,
							readOnly: false,
							showEnterButton: true,
							setOnEnterKey: true,
						},
						applyVacation: {
							type: 'setState',
							id: `${id}.apply.vacation.apply`,
							label: { en: 'Apply vacation', de: 'Urlaub anwenden' },
							val: true,
							variant: 'contained',
							color: 'primary',
						},
						nameValue: {
							type: 'state',
							oid: `${prefix}.apply.name.value`,
							label: { en: 'Thermostat name', de: 'Thermostatname' },
							control: 'input',
						},
						applyName: {
							type: 'setState',
							id: `${id}.apply.name.apply`,
							label: { en: 'Apply name', de: 'Namen anwenden' },
							val: true,
							variant: 'contained',
							color: 'primary',
						},
					},
				},
			},
		};
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

	/** Parses a deterministic device id string back into groupId and thermostatId. */
	_parseDeviceId(deviceId) {
		const match = String(deviceId ?? '').match(/^([^/]+)\/([^/]+)$/);
		return match ? { groupId: match[1], thermostatId: match[2] } : null;
	}

	/** Writes a control state and returns the latest value from DB. */
	async _writeState(deviceId, suffix, value) {
		const ids = this._parseDeviceId(deviceId);
		if (!ids) {
			throw new Error(`Invalid device id format: ${deviceId}. Expected format: groupId/thermostatId`);
		}
		const { groupId, thermostatId } = ids;
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
