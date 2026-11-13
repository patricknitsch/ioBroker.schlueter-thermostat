'use strict';
/* eslint-disable jsdoc/require-param */

const { DeviceManagement } = require('@iobroker/dm-utils');
const { safeId } = require('./util');
const { thermostatIndicators, instanceIndicators } = require('./dm-indicators');
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
			indicators: instanceIndicators(this.adapter.namespace, { local: this._localEnabled() }),
		};
	}

	/** @returns {boolean} local control (relay / local only) is enabled */
	_localEnabled() {
		const mode = this.adapter.config?.localMode;
		return mode === 'relay' || mode === 'local';
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
			const onlineState = await this.adapter.getStateAsync(
				`${this.adapter.namespace}.${this._prefix(groupId, thermostatId)}.online`,
			);
			const isOnline = onlineState?.val === true;

			context.addDevice({
				id: dmDeviceId,
				name: thermostatName,
				icon: `/adapter/${this.adapter.name}/schlueter-thermostat.jpg`,
				status: {
					connection: {
						stateId: `${this.adapter.namespace}.${this._prefix(groupId, thermostatId)}.online`,
						mapping: { true: 'connected', false: 'disconnected' },
					},
				},
				color: !isOnline ? '#fff' : undefined,
				backgroundColor: !isOnline ? '#f44336' : undefined,
				identifier: device.native?.serialNumber ? String(device.native.serialNumber) : undefined,
				manufacturer: 'OJ Electronics',
				model: 'OJ Microline WD5 (Wi-Fi)',
				connectionType: 'wifi',
				indicators: thermostatIndicators(`${this.adapter.namespace}.${this._prefix(groupId, thermostatId)}`, {
					local: this._localEnabled(),
					mode: String(this.adapter.config?.localMode || 'off'),
				}),
				controls: [],
				actions: [],
				hasDetails: true,
				group: {
					key: `group/${groupId}`,
					name: groupName,
				},
			});
		}
	}

	/**
	 * Returns the compact control form of the device details view.
	 *
	 * @param {string} deviceId device id in `groupId/thermostatId` format
	 */
	async getDeviceDetails(deviceId) {
		const ids = this._parseDeviceId(deviceId);
		if (!ids) {
			return { id: deviceId, schema: this._emptyDetailsSchema() };
		}
		const prefix = this._prefix(ids.groupId, ids.thermostatId);
		const obj = await this.adapter.getObjectAsync(prefix);
		const serial = obj?.native?.serialNumber ? String(obj.native.serialNumber) : '';
		return {
			id: deviceId,
			schema: this._detailsSchema(prefix, `${this.adapter.namespace}.${prefix}`, ids.thermostatId, serial),
		};
	}

	/** @returns {import('@iobroker/dm-utils').JsonFormSchema} empty details schema */
	_emptyDetailsSchema() {
		return { type: 'panel', items: {} };
	}

	/**
	 * Compact control form: one row per function – label, inputs, small button.
	 *
	 * @param {string} prefix device id relative to the namespace
	 * @param {string} id full device id
	 * @param {string} thermostatId thermostat number
	 * @param {string} serial serial number
	 * @returns {import('@iobroker/dm-utils').JsonFormSchema} schema
	 */
	_detailsSchema(prefix, id, thermostatId, serial) {
		const label = (key, text) => ({
			[`_l_${key}`]: {
				type: 'staticText',
				text,
				newLine: true,
				xs: 3,
				style: { fontWeight: 600, paddingTop: 16 },
			},
		});
		const input = (key, oid, text, opts) => ({
			[key]: {
				type: 'state',
				oid: `${prefix}.apply.${oid}`,
				label: text,
				control: 'input',
				...opts,
			},
		});
		const button = (key, oid, text, xs = 3) => ({
			[key]: {
				type: 'setState',
				id: `${id}.apply.${oid}.apply`,
				label: text,
				val: true,
				variant: 'outlined',
				color: 'primary',
				xs,
				style: { marginTop: 8 },
			},
		});
		return {
			type: 'panel',
			innerStyle: { maxWidth: 560 },
			items: {
				thermostatId: {
					type: 'staticInfo',
					label: { en: 'Thermostat', de: 'Thermostat' },
					data: thermostatId,
					addColon: true,
					size: 'normal',
					newLine: true,
					xs: 6,
				},
				serial: {
					type: 'staticInfo',
					label: { en: 'Serial number', de: 'Seriennummer' },
					data: serial || '-',
					addColon: true,
					size: 'normal',
					xs: 6,
				},
				_d0: { type: 'divider' },

				...label('manual', { en: 'Manual', de: 'Manuell' }),
				...input(
					'manualSetpoint',
					'manual.setpoint',
					{ en: 'Setpoint', de: 'Sollwert' },
					{
						min: 5,
						max: 35,
						step: 0.5,
						unit: '°C',
						xs: 6,
					},
				),
				...button('applyManual', 'manual', { en: 'Apply', de: 'Anwenden' }),

				...label('comfort', { en: 'Comfort', de: 'Komfort' }),
				...input(
					'comfortSetpoint',
					'comfort.setpoint',
					{ en: 'Setpoint', de: 'Sollwert' },
					{
						min: 12,
						max: 35,
						step: 0.5,
						unit: '°C',
						xs: 3,
					},
				),
				...input(
					'comfortDuration',
					'comfort.durationMinutes',
					{ en: 'Duration', de: 'Dauer' },
					{
						min: 1,
						max: 1440,
						step: 1,
						unit: 'min',
						xs: 3,
					},
				),
				...button('applyComfort', 'comfort', { en: 'Apply', de: 'Anwenden' }),

				...label('boost', { en: 'Boost', de: 'Boost' }),
				...input(
					'boostDuration',
					'boost.durationMinutes',
					{ en: 'Duration', de: 'Dauer' },
					{
						min: 1,
						max: 1440,
						step: 1,
						unit: 'min',
						xs: 6,
					},
				),
				...button('applyBoost', 'boost', { en: 'Start', de: 'Starten' }),

				...label('mode', { en: 'Mode', de: 'Modus' }),
				...button('applySchedule', 'schedule', { en: 'Schedule', de: 'Zeitplan' }),
				...button('applyEco', 'eco', { en: 'Eco', de: 'Eco' }),

				...label('vacation', { en: 'Vacation', de: 'Urlaub' }),
				vacationEnabled: {
					type: 'state',
					oid: `${prefix}.apply.vacation.enabled`,
					label: { en: 'Active', de: 'Aktiv' },
					control: 'switch',
					xs: 2,
				},
				...input(
					'vacationBegin',
					'vacation.begin',
					{ en: 'Begin (YYYY-MM-DD)', de: 'Beginn (JJJJ-MM-TT)' },
					{ xs: 2 },
				),
				...input('vacationEnd', 'vacation.end', { en: 'End (YYYY-MM-DD)', de: 'Ende (JJJJ-MM-TT)' }, { xs: 2 }),
				...button('applyVacation', 'vacation', { en: 'Apply', de: 'Anwenden' }),

				...label('name', { en: 'Name', de: 'Name' }),
				...input('nameValue', 'name.value', { en: 'Thermostat name', de: 'Thermostatname' }, { xs: 6 }),
				...button('applyName', 'name', { en: 'Rename', de: 'Umbenennen' }),
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
