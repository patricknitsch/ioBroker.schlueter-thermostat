'use strict';
/* eslint-disable jsdoc/require-param */

const { DeviceManagement } = require('@iobroker/dm-utils');
const { safeId } = require('./util');
const GROUP_TO_THERMOSTATS_OFFSET = 2;

/** Device Manager integration for thermostat devices. */
class SchlueterDeviceManagement extends DeviceManagement {
	/** Forwards adapter message events to dm-utils message handling. */
	handleAdapterMessage(obj) {
		this['onMessage'](obj);
	}

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
				controls: [],
				actions: [],
				hasDetails: true,
				customInfo: {
					id: `card/${dmDeviceId}`,
					schema: {
						type: 'panel',
						items: {
							roomTemperature: {
								type: 'state',
								oid: `${this.adapter.namespace}.${this._prefix(groupId, thermostatId)}.temperature.room`,
								foreign: true,
								label: { en: 'Room temperature', de: 'Raumtemperatur' },
								unit: '°C',
								newLine: true,
							},
							floorTemperature: {
								type: 'state',
								oid: `${this.adapter.namespace}.${this._prefix(groupId, thermostatId)}.temperature.floor`,
								foreign: true,
								label: { en: 'Floor temperature', de: 'Bodentemperatur' },
								unit: '°C',
								newLine: true,
							},
							heating: {
								type: 'state',
								oid: `${this.adapter.namespace}.${this._prefix(groupId, thermostatId)}.heating`,
								foreign: true,
								label: { en: 'Heating', de: 'Heizen' },
								trueText: { en: 'On', de: 'An' },
								falseText: { en: 'Off', de: 'Aus' },
								newLine: true,
							},
							regulationMode: {
								type: 'state',
								oid: `${this.adapter.namespace}.${this._prefix(groupId, thermostatId)}.regulationMode`,
								foreign: true,
								label: { en: 'Regulation mode', de: 'Regelungsmodus' },
								states: {
									1: 'Schedule (Zeitplan)',
									2: 'Comfort (Komfort)',
									3: 'Manual (Manuell)',
									4: 'Vacation (Urlaub)',
									5: 'Unknown (Unbekannt)',
									6: 'Frost Protection (Frostschutz)',
									7: 'Unknown (Unbekannt)',
									8: 'Boost (Boost)',
									9: 'Eco (Eco)',
								},
								newLine: true,
							},
							consumption: {
								type: 'state',
								oid: `${this.adapter.namespace}.${this._prefix(groupId, thermostatId)}.energy.value0`,
								foreign: true,
								label: { en: 'Consumption', de: 'Verbrauch' },
								unit: 'kWh',
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
						_h1: {
							type: 'header',
							text: { en: 'Information', de: 'Informationen' },
							sm: 12,
							newLine: true,
						},
						_d1: { type: 'divider', color: 'primary' },
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
					},
				},
				controls: {
					type: 'panel',
					label: { en: 'Controls', de: 'Steuerung' },
					innerStyle: { maxWidth: 450 },
					items: {
						_h2: { type: 'header', text: { en: 'Controls', de: 'Steuerung' }, sm: 12, newLine: true },
						_h2_1: {
							type: 'header',
							text: { en: 'Manual Mode', de: 'Handbetrieb' },
							sm: 12,
							newLine: true,
						},
						_d2: { type: 'divider', color: 'primary' },
						manualSetpoint: {
							type: 'state',
							oid: `${prefix}.apply.manual.setpoint`,
							label: { en: 'Manual setpoint (°C)', de: 'Manueller Sollwert (°C)' },
							control: 'input',
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
						_h3: {
							type: 'header',
							text: { en: 'Comfort Mode', de: 'Komfort Betrieb' },
							sm: 12,
							newLine: true,
						},
						_d3: { type: 'divider', color: 'primary' },
						comfortSetpoint: {
							type: 'state',
							oid: `${prefix}.apply.comfort.setpoint`,
							label: { en: 'Comfort setpoint (°C)', de: 'Komfort-Sollwert (°C)' },
							control: 'input',
							min: 12,
							max: 35,
							step: 0.5,
						},
						comfortDuration: {
							type: 'state',
							oid: `${prefix}.apply.comfort.durationMinutes`,
							label: { en: 'Comfort duration (min)', de: 'Komfort-Dauer (Min)' },
							control: 'input',
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
						_h4: { type: 'header', text: { en: 'Schedule Mode', de: 'Zeitplan' }, sm: 12, newLine: true },
						_d4: { type: 'divider', color: 'primary' },
						applySchedule: {
							type: 'setState',
							id: `${id}.apply.schedule.apply`,
							label: { en: 'Activate schedule mode', de: 'Zeitplanmodus aktivieren' },
							val: true,
							variant: 'contained',
							color: 'primary',
						},
						_h5: { type: 'header', text: { en: 'Eco Mode', de: 'Eco Modus' }, sm: 12, newLine: true },
						_d5: { type: 'divider', color: 'primary' },
						applyEco: {
							type: 'setState',
							id: `${id}.apply.eco.apply`,
							label: { en: 'Activate eco mode', de: 'Eco-Modus aktivieren' },
							val: true,
							variant: 'contained',
							color: 'primary',
						},
						_h6: { type: 'header', text: { en: 'Boost Mode', de: 'Boost Mode' }, sm: 12, newLine: true },
						_d6: { type: 'divider', color: 'primary' },
						boostDuration: {
							type: 'state',
							oid: `${prefix}.apply.boost.durationMinutes`,
							label: { en: 'Boost duration (min)', de: 'Boost-Dauer (Min)' },
							control: 'input',
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
						_h7: {
							type: 'header',
							text: { en: 'Vacation Mode', de: 'Urlaubsmodus' },
							sm: 12,
							newLine: true,
						},
						_d7: { type: 'divider', color: 'primary' },
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
							control: 'input',
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
						_h8: {
							type: 'header',
							text: { en: 'Thermostat name', de: 'Thermostat Name' },
							sm: 12,
							newLine: true,
						},
						_d8: { type: 'divider', color: 'primary' },
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
