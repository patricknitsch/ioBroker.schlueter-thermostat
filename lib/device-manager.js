'use strict';
/* eslint-disable jsdoc/require-param */

const { DeviceManagement } = require('@iobroker/dm-utils');
const { safeId } = require('./util');
const { thermostatIndicators, instanceIndicators, icon } = require('./dm-indicators');
const GROUP_TO_THERMOSTATS_OFFSET = 2;
/** WD5: days 1 (Monday) … 7, six events each */
const DAYS = [1, 2, 3, 4, 5, 6, 7];
const EVENTS = [0, 1, 2, 3, 4, 5];
const DAY_NAMES = {
	en: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
	de: ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'],
};

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
				en: 'Serial number',
				de: 'Seriennummer',
			},
			smallCards: false,
			indicators: instanceIndicators(this.adapter.namespace, {
				local: this._localEnabled(),
				mode: String(this.adapter.config?.localMode || 'off'),
			}),
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
				indicators: thermostatIndicators(`${this.adapter.namespace}.${this._prefix(groupId, thermostatId)}`, {
					local: this._localEnabled(),
					mode: String(this.adapter.config?.localMode || 'off'),
				}),
				controls: [],
				actions: [
					{
						id: 'schedule',
						icon: icon('schedule', 'info'),
						description: { en: 'Weekly schedule', de: 'Wochenplan' },
						handler: (id, ctx) => this._editSchedule(id, ctx),
					},
				],
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
		// Responsive: `xs` is the phone layout (label above, fields side by side),
		// `sm` and up the desktop layout (label left, fields and button in one row).
		const label = (key, text) => ({
			[`_l_${key}`]: {
				type: 'staticText',
				text,
				newLine: true,
				xs: 12,
				sm: 3,
				style: { fontWeight: 600, paddingTop: 12 },
			},
		});
		const input = (key, oid, text, size, opts = {}) => ({
			[key]: {
				type: 'state',
				oid: `${prefix}.apply.${oid}`,
				label: text,
				control: 'input',
				...size,
				...opts,
			},
		});
		const button = (key, oid, text, size) => ({
			[key]: {
				type: 'setState',
				id: `${id}.apply.${oid}.apply`,
				label: text,
				val: true,
				variant: 'outlined',
				color: 'primary',
				...size,
				style: { marginTop: 8 },
			},
		});
		const temp = { min: 5, max: 35, step: 0.5, unit: '°C' };
		const minutes = { min: 1, max: 1440, step: 1, unit: 'min' };
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
					xs: 12,
					sm: 6,
				},
				serial: {
					type: 'staticInfo',
					label: { en: 'Serial number', de: 'Seriennummer' },
					data: serial || '-',
					addColon: true,
					size: 'normal',
					xs: 12,
					sm: 6,
				},

				...label('manual', { en: 'Manual', de: 'Manuell' }),
				...input(
					'manualSetpoint',
					'manual.setpoint',
					{ en: 'Setpoint', de: 'Sollwert' },
					{ xs: 6, sm: 6 },
					temp,
				),
				...button('applyManual', 'manual', { en: 'Apply', de: 'Anwenden' }, { xs: 6, sm: 3 }),

				...label('comfort', { en: 'Comfort', de: 'Komfort' }),
				...input(
					'comfortSetpoint',
					'comfort.setpoint',
					{ en: 'Setpoint', de: 'Sollwert' },
					{ xs: 4, sm: 3 },
					{ ...temp, min: 12 },
				),
				...input(
					'comfortDuration',
					'comfort.durationMinutes',
					{ en: 'Duration', de: 'Dauer' },
					{ xs: 4, sm: 3 },
					minutes,
				),
				...button('applyComfort', 'comfort', { en: 'Apply', de: 'Anwenden' }, { xs: 4, sm: 3 }),

				...label('boost', { en: 'Boost', de: 'Boost' }),
				...input(
					'boostDuration',
					'boost.durationMinutes',
					{ en: 'Duration', de: 'Dauer' },
					{ xs: 6, sm: 6 },
					minutes,
				),
				...button('applyBoost', 'boost', { en: 'Start', de: 'Starten' }, { xs: 6, sm: 3 }),

				...label('mode', { en: 'Mode', de: 'Modus' }),
				...button('applySchedule', 'schedule', { en: 'Schedule', de: 'Zeitplan' }, { xs: 6, sm: 3 }),
				...button('applyEco', 'eco', { en: 'Eco', de: 'Eco' }, { xs: 6, sm: 3 }),

				// two rows on every screen: switch, then the days and the button
				...label('vacation', { en: 'Vacation', de: 'Urlaub' }),
				vacationEnabled: {
					type: 'state',
					oid: `${prefix}.apply.vacation.enabled`,
					label: { en: 'Active', de: 'Aktiv' },
					control: 'switch',
					xs: 12,
					sm: 9,
				},
				...input(
					'vacationBegin',
					'vacation.begin',
					{ en: 'Begin (YYYY-MM-DD)', de: 'Beginn (JJJJ-MM-TT)' },
					{ xs: 6, sm: 4, newLine: true },
				),
				...input(
					'vacationEnd',
					'vacation.end',
					{ en: 'End (YYYY-MM-DD)', de: 'Ende (JJJJ-MM-TT)' },
					{
						xs: 6,
						sm: 5,
					},
				),
				...button('applyVacation', 'vacation', { en: 'Apply', de: 'Anwenden' }, { xs: 12, sm: 3 }),

				...label('name', { en: 'Name', de: 'Name' }),
				...input('nameValue', 'name.value', { en: 'Thermostat name', de: 'Thermostatname' }, { xs: 6, sm: 6 }),
				...button('applyName', 'name', { en: 'Rename', de: 'Umbenennen' }, { xs: 6, sm: 3 }),
			},
		};
	}

	/**
	 * Separate page for the weekly schedule: one tab per day with the six
	 * events, filled from apply.scheduleProgram (offered by local control).
	 * The changes are stored there and sent locally at once, so the user
	 * sees whether the thermostat took them.
	 *
	 * @param {string} deviceId device id in `groupId/thermostatId` format
	 * @param {import('@iobroker/dm-utils').ActionContext} context dialog context
	 * @returns {Promise<{refresh: 'none'}>} nothing to reload
	 */
	async _editSchedule(deviceId, context) {
		const none = { refresh: /** @type {const} */ ('none') };
		const ids = this._parseDeviceId(deviceId);
		if (!ids) {
			return none;
		}
		const prefix = this._prefix(ids.groupId, ids.thermostatId);
		const stateId = (d, e, k) => `${prefix}.apply.scheduleProgram.day${d}.event${e}.${k}`;
		/** @type {Record<string, any>} */
		const data = {};
		for (const d of DAYS) {
			for (const e of EVENTS) {
				for (const k of ['time', 'temperature', 'active']) {
					const st = await this.adapter.getStateAsync(stateId(d, e, k));
					if (st && st.val !== null && st.val !== undefined) {
						data[`d${d}e${e}${k}`] = k === 'time' ? String(st.val).slice(0, 5) : st.val;
					}
				}
			}
		}
		if (data.d1e0time === undefined) {
			await context.showMessage({
				en: 'The weekly schedule can only be edited with local control (WD5 connected locally, "Send commands locally" on).',
				de: 'Der Wochenplan lässt sich nur mit lokaler Steuerung bearbeiten (WD5 lokal verbunden, „Befehle lokal senden“ an).',
			});
			return none;
		}

		const result = await context.showForm(this._scheduleSchema(data), {
			data,
			title: { en: 'Weekly schedule', de: 'Wochenplan' },
			maxWidth: 'sm',
		});
		if (!result) {
			return none;
		}
		let changed = 0;
		for (const d of DAYS) {
			for (const e of EVENTS) {
				for (const k of ['time', 'temperature', 'active']) {
					const key = `d${d}e${e}${k}`;
					if (key in result && result[key] !== data[key] && result[key] !== '' && result[key] !== null) {
						await this.adapter.setStateAsync(stateId(d, e, k), { val: result[key], ack: true });
						changed++;
					}
				}
			}
		}
		if (!changed) {
			return none;
		}
		const obj = await this.adapter.getObjectAsync(prefix);
		const serial = obj?.native?.serialNumber ? String(obj.native.serialNumber) : '';
		try {
			const sent =
				!!serial && (await /** @type {any} */ (this.adapter).local?.apply('scheduleProgram', serial, prefix));
			await context.showMessage(
				sent
					? { en: 'The thermostat took the schedule.', de: 'Das Thermostat hat den Zeitplan übernommen.' }
					: {
							en: 'Saved, but not sent: the thermostat is not connected locally or local commands are off.',
							de: 'Gespeichert, aber nicht gesendet: Das Thermostat ist nicht lokal verbunden oder lokale Befehle sind aus.',
						},
			);
		} catch (e) {
			await context.showMessage({
				en: `The schedule was not sent: ${e?.message || e}`,
				de: `Der Zeitplan wurde nicht gesendet: ${e?.message || e}`,
			});
		}
		return none;
	}

	/**
	 * Form of the weekly schedule: a tab per day, a row per event.
	 *
	 * @param {Record<string, any>} data values (keys `d<day>e<event><key>`)
	 * @returns {import('@iobroker/dm-utils').JsonFormSchema} schema
	 */
	_scheduleSchema(data) {
		/** @type {Record<string, any>} */
		const tabs = {};
		for (const d of DAYS) {
			/** @type {Record<string, any>} */
			const items = {};
			for (const e of EVENTS) {
				if (data[`d${d}e${e}time`] === undefined) {
					continue;
				}
				items[`d${d}e${e}time`] = {
					type: 'text',
					label: { en: `Event ${e + 1}: time (HH:MM)`, de: `Schaltpunkt ${e + 1}: Zeit (HH:MM)` },
					validator: `/^([01]?\\d|2[0-3]):[0-5]\\d$/.test(data.d${d}e${e}time)`,
					validatorErrorText: { en: 'HH:MM', de: 'HH:MM' },
					newLine: true,
					xs: 5,
				};
				items[`d${d}e${e}temperature`] = {
					type: 'number',
					label: { en: 'Temperature', de: 'Temperatur' },
					min: 5,
					max: 35,
					step: 0.5,
					unit: '°C',
					xs: 4,
				};
				items[`d${d}e${e}active`] = {
					type: 'checkbox',
					label: { en: 'Active', de: 'Aktiv' },
					xs: 3,
				};
			}
			tabs[`day${d}`] = {
				type: 'panel',
				label: { en: DAY_NAMES.en[d - 1], de: DAY_NAMES.de[d - 1] },
				items,
			};
		}
		return { type: 'tabs', items: tabs };
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
