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
				identifier: `${groupId} / ${thermostatId}`,
				name: thermostatName,
				model: 'OJ Microline OWD5',
				connectionType: 'wifi',
				status: {
					connection: { stateId: onlineStateId, mapping: { true: 'connected', false: 'disconnected' } },
				},
				group: {
					key: `group/${groupId}`,
					name: groupName,
				},
				controls: [
					// ── Status ──────────────────────────────────────────────────
					{
						id: 'headerStatus',
						type: 'header',
						label: { en: 'Status', de: 'Status' },
					},
					{
						id: 'roomTemp',
						type: 'info',
						label: { en: 'Room temperature', de: 'Raumtemperatur' },
						unit: '°C',
						stateId: roomTempStateId,
					},
					{
						id: 'floorTemp',
						type: 'info',
						label: { en: 'Floor temperature', de: 'Bodentemperatur' },
						unit: '°C',
						stateId: floorTempStateId,
					},
					{
						id: 'heating',
						type: 'info',
						label: { en: 'Heating', de: 'Heizen' },
						textTrue: { en: 'Heating', de: 'Heizen' },
						textFalse: { en: 'Idle', de: 'Leerlauf' },
						stateId: heatingStateId,
					},
					{
						id: 'regulationMode',
						type: 'info',
						label: { en: 'Regulation mode', de: 'Regulierungsmodus' },
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
					// ── Manual mode ─────────────────────────────────────────────
					{
						id: 'headerManual',
						type: 'header',
						label: { en: 'Manual mode', de: 'Manueller Modus' },
					},
					{
						id: 'manualSetpoint',
						type: 'number',
						label: { en: 'Setpoint (°C)', de: 'Sollwert (°C)' },
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
						label: { en: 'Apply manual mode', de: 'Manuellen Modus anwenden' },
						handler: async deviceId => {
							return await this._writeState(deviceId, 'apply.manual.apply', true);
						},
					},
					// ── Comfort mode ─────────────────────────────────────────────
					{
						id: 'headerComfort',
						type: 'header',
						label: { en: 'Comfort mode', de: 'Komfortmodus' },
					},
					{
						id: 'comfortSetpoint',
						type: 'number',
						label: { en: 'Setpoint (°C)', de: 'Sollwert (°C)' },
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
						id: 'comfortDuration',
						type: 'number',
						label: { en: 'Duration (min)', de: 'Dauer (Min)' },
						min: 1,
						max: 1440,
						unit: 'min',
						stateId: `${prefix}.apply.comfort.durationMinutes`,
						handler: async (deviceId, _controlId, state) => {
							return await this._writeState(deviceId, 'apply.comfort.durationMinutes', Number(state));
						},
					},
					{
						id: 'applyComfort',
						type: 'button',
						icon: 'play',
						label: { en: 'Apply comfort mode', de: 'Komfortmodus anwenden' },
						handler: async deviceId => {
							return await this._writeState(deviceId, 'apply.comfort.apply', true);
						},
					},
					// ── Schedule mode ────────────────────────────────────────────
					{
						id: 'headerSchedule',
						type: 'header',
						label: { en: 'Schedule mode', de: 'Zeitplanmodus' },
					},
					{
						id: 'applySchedule',
						type: 'button',
						icon: 'play',
						label: { en: 'Activate schedule mode', de: 'Zeitplanmodus aktivieren' },
						handler: async deviceId => {
							return await this._writeState(deviceId, 'apply.schedule.apply', true);
						},
					},
					// ── Eco mode ─────────────────────────────────────────────────
					{
						id: 'headerEco',
						type: 'header',
						label: { en: 'Eco mode', de: 'Eco-Modus' },
					},
					{
						id: 'applyEco',
						type: 'button',
						icon: 'play',
						label: { en: 'Activate eco mode', de: 'Eco-Modus aktivieren' },
						handler: async deviceId => {
							return await this._writeState(deviceId, 'apply.eco.apply', true);
						},
					},
					// ── Boost mode ───────────────────────────────────────────────
					{
						id: 'headerBoost',
						type: 'header',
						label: { en: 'Boost mode', de: 'Boost-Modus' },
					},
					{
						id: 'boostDuration',
						type: 'number',
						label: { en: 'Duration (min)', de: 'Dauer (Min)' },
						min: 1,
						max: 1440,
						unit: 'min',
						stateId: `${prefix}.apply.boost.durationMinutes`,
						handler: async (deviceId, _controlId, state) => {
							return await this._writeState(deviceId, 'apply.boost.durationMinutes', Number(state));
						},
					},
					{
						id: 'applyBoost',
						type: 'button',
						icon: 'play',
						label: { en: 'Activate boost mode', de: 'Boost-Modus aktivieren' },
						handler: async deviceId => {
							return await this._writeState(deviceId, 'apply.boost.apply', true);
						},
					},
					// ── Vacation ─────────────────────────────────────────────────
					{
						id: 'headerVacation',
						type: 'header',
						label: { en: 'Vacation', de: 'Urlaub' },
					},
					{
						id: 'vacationEnabled',
						type: 'switch',
						label: { en: 'Enabled', de: 'Aktiviert' },
						stateId: `${prefix}.apply.vacation.enabled`,
						handler: async (deviceId, _controlId, state) => {
							return await this._writeState(deviceId, 'apply.vacation.enabled', Boolean(state));
						},
					},
					{
						id: 'vacationBegin',
						type: 'text',
						label: { en: 'Begin (YYYY-MM-DD)', de: 'Beginn (JJJJ-MM-TT)' },
						stateId: `${prefix}.apply.vacation.begin`,
						handler: async (deviceId, _controlId, state) => {
							return await this._writeState(deviceId, 'apply.vacation.begin', String(state));
						},
					},
					{
						id: 'vacationEnd',
						type: 'text',
						label: { en: 'End (YYYY-MM-DD)', de: 'Ende (JJJJ-MM-TT)' },
						stateId: `${prefix}.apply.vacation.end`,
						handler: async (deviceId, _controlId, state) => {
							return await this._writeState(deviceId, 'apply.vacation.end', String(state));
						},
					},
					{
						id: 'vacationTemperature',
						type: 'number',
						label: { en: 'Temperature (°C)', de: 'Temperatur (°C)' },
						min: 5,
						max: 35,
						unit: '°C',
						stateId: `${prefix}.apply.vacation.temperature`,
						handler: async (deviceId, _controlId, state) => {
							return await this._writeState(deviceId, 'apply.vacation.temperature', Number(state));
						},
					},
					{
						id: 'applyVacation',
						type: 'button',
						icon: 'play',
						label: { en: 'Apply vacation', de: 'Urlaub anwenden' },
						handler: async deviceId => {
							return await this._writeState(deviceId, 'apply.vacation.apply', true);
						},
					},
					// ── Thermostat name ──────────────────────────────────────────
					{
						id: 'headerName',
						type: 'header',
						label: { en: 'Thermostat name', de: 'Thermostatname' },
					},
					{
						id: 'nameValue',
						type: 'text',
						label: { en: 'Name', de: 'Name' },
						stateId: `${prefix}.apply.name.value`,
						handler: async (deviceId, _controlId, state) => {
							return await this._writeState(deviceId, 'apply.name.value', String(state));
						},
					},
					{
						id: 'applyName',
						type: 'button',
						icon: 'play',
						label: { en: 'Apply name', de: 'Namen anwenden' },
						handler: async deviceId => {
							return await this._writeState(deviceId, 'apply.name.apply', true);
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
