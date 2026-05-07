'use strict';
/* eslint-disable jsdoc/require-param */

const { DeviceManagement } = require('@iobroker/dm-utils');
const { safeId } = require('./util');
const GROUP_TO_THERMOSTATS_OFFSET = 2;

/** Maps numeric regulation mode values to human-readable labels. */
const REGULATION_MODES = {
	1: { en: 'Schedule', de: 'Zeitplan' },
	2: { en: 'Comfort', de: 'Komfort' },
	3: { en: 'Manual', de: 'Manuell' },
	4: { en: 'Vacation', de: 'Urlaub' },
	6: { en: 'Frost Protection', de: 'Frostschutz' },
	8: { en: 'Boost', de: 'Boost' },
	9: { en: 'Eco', de: 'Eco' },
};

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
			const thermostatName = String(device.common?.name || `Thermostat ${thermostatId}`);

			context.addDevice({
				id: dmDeviceId,
				name: thermostatName,
				icon: `/adapter/${this.adapter.name}/schlueter-thermostat.png`,
				model: 'OJ Microline OWD5',
				status: {
					connection: { stateId: onlineStateId, mapping: { true: 'connected', false: 'disconnected' } },
				},
				actions: [
					{
						id: 'openThermostatSettings',
						icon: 'edit',
						color: 'primary',
						description: { en: 'Open thermostat settings', de: 'Thermostat-Einstellungen öffnen' },
						handler: async (deviceId, context) => {
							const details = await this.getDeviceDetails(deviceId);
							if (!details || 'error' in details) {
								return { refresh: 'none' };
							}
							await context.showForm(details.schema, {
								title: { en: 'Thermostat settings', de: 'Thermostat-Einstellungen' },
							});
							return { refresh: 'none' };
						},
					},
					{
						id: 'openAdapterConfig',
						icon: 'settings',
						color: 'primary',
						description: { en: 'Open adapter configuration', de: 'Adapter-Konfiguration öffnen' },
						handler: async () => {
							return {
								url: `#tab-instances/config/system.adapter.${this.adapter.namespace}`,
								target: '_self',
							};
						},
					},
				],
				hasDetails: false,
				group: {
					key: `group/${groupId}`,
					name: groupName,
				},
				controls: [
					{
						id: 'groupNumber',
						type: 'info',
						label: { en: 'Group', de: 'Gruppe' },
						getStateHandler: async () => this._toVirtualState(groupId),
					},
					{
						id: 'thermostatNumber',
						type: 'info',
						label: { en: 'Thermostat', de: 'Thermostat' },
						getStateHandler: async () => this._toVirtualState(thermostatId),
					},
					{
						id: 'floorTemp',
						type: 'info',
						label: { en: 'Floor', de: 'Boden' },
						unit: '°C',
						stateId: floorTempStateId,
					},
					{
						id: 'roomTemp',
						type: 'info',
						label: { en: 'Room', de: 'Raum' },
						unit: '°C',
						stateId: roomTempStateId,
					},
					{
						id: 'heating',
						type: 'info',
						label: { en: 'Heating', de: 'Heizen' },
						textTrue: { en: 'On', de: 'An' },
						textFalse: { en: 'Off', de: 'Aus' },
						stateId: heatingStateId,
					},
					{
						id: 'regulationMode',
						type: 'info',
						label: { en: 'Mode', de: 'Modus' },
						getStateHandler: async (deviceId, _actionId, _context) => {
							const state = await this._readState(deviceId, 'regulationMode');
							const modeLabel = REGULATION_MODES[state?.val];
							const val = modeLabel ? modeLabel.en : String(state?.val ?? '');
							return {
								val,
								ack: true,
								ts: state?.ts ?? Date.now(),
								lc: state?.lc ?? Date.now(),
								from: state?.from ?? `system.adapter.${this.adapter.namespace}`,
							};
						},
					},
				],
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
			schema: this._settingsSchema(prefix, id),
		};
	}

	/** @returns {import('@iobroker/dm-utils').JsonFormSchema} empty details schema */
	_emptyDetailsSchema() {
		return { type: 'panel', items: {} };
	}

	/** @returns {import('@iobroker/dm-utils').JsonFormSchema} thermostat settings schema */
	_settingsSchema(prefix, id) {
		return {
			type: 'panel',
			items: {
				manualSetpoint: {
					type: 'state',
					oid: `${prefix}.apply.manual.setpoint`,
					label: { en: 'Manual setpoint (°C)', de: 'Manueller Sollwert (°C)' },
					control: 'number',
					min: 12,
					max: 35,
					step: 0.5,
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
				},
				comfortDuration: {
					type: 'state',
					oid: `${prefix}.apply.comfort.durationMinutes`,
					label: { en: 'Comfort duration (min)', de: 'Komfort-Dauer (Min)' },
					control: 'number',
					min: 1,
					max: 1440,
					step: 1,
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
		};
	}

	/** Returns a synthetic state object for static info controls. */
	_toVirtualState(value) {
		return {
			val: String(value),
			ack: true,
			ts: Date.now(),
			lc: Date.now(),
			from: `system.adapter.${this.adapter.namespace}`,
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

	/** Reads a state for a given device id and state suffix. */
	async _readState(deviceId, suffix) {
		const ids = this._parseDeviceId(deviceId);
		if (!ids) {
			return null;
		}
		const base = this._prefix(ids.groupId, ids.thermostatId);
		return await this.adapter.getStateAsync(`${base}.${suffix}`);
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
