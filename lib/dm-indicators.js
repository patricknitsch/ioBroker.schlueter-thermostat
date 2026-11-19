'use strict';

// ============================================================================
// Status indicators for the Device Manager cards (and the instance toolbar).
//
// The indicators read their values live from the thermostat states, so the
// cards follow every change without any action of the adapter. Icons are
// small SVGs (Material Design icon paths) in fixed colours, because a colour
// token does not apply to image icons; levels switch between coloured icons.
// ============================================================================

const { svg } = require('./icons');

/**
 * SVG icon as data URI.
 *
 * @param {Parameters<typeof svg>[0]} name icon name
 * @param {Parameters<typeof svg>[1]} color colour token
 * @returns {string} data URI
 */
function icon(name, color) {
	return `data:image/svg+xml;base64,${Buffer.from(svg(name, color)).toString('base64')}`;
}

const MODE_TEXT = {
	1: { en: 'Schedule', de: 'Zeitplan' },
	2: { en: 'Comfort', de: 'Komfort' },
	3: { en: 'Manual', de: 'Manuell' },
	4: { en: 'Vacation', de: 'Urlaub' },
	6: { en: 'Frost protection', de: 'Frostschutz' },
	8: { en: 'Boost', de: 'Boost' },
	9: { en: 'Eco', de: 'Eco' },
};

/**
 * Indicators of one thermostat card.
 *
 * @param {string} base full state id of the thermostat device (namespace + device id)
 * @param {{local: boolean, mode?: string}} opts whether local control is enabled, and the local mode
 *   (the connection indicator is always shown: cloud / relay / local)
 * @returns {import('@iobroker/dm-utils').StatusIndicator[]} indicators
 */
function thermostatIndicators(base, opts) {
	/** @type {import('@iobroker/dm-utils').StatusIndicator[]} */
	const list = [];
	list.push({
		id: 'connection',
		value: { stateId: `${base}.connection` },
		icon: icon('cloud', 'info'),
		label: { en: 'Connection', de: 'Verbindung' },
		tooltip: { en: 'Connection: cloud / relay / local', de: 'Verbindung: Cloud / Relay / Lokal' },
		levels: [
			{ value: 'cloud', icon: icon('cloud', 'info'), text: { en: 'Cloud', de: 'Cloud' } },
			{ value: 'relay', icon: icon('relay', 'ok'), text: { en: 'Relay', de: 'Relay' } },
			{ value: 'local', icon: icon('home', 'ok'), text: { en: 'Local', de: 'Lokal' } },
		],
		order: 10,
		configurable: true,
	});
	list.push(
		{
			id: 'heating',
			value: { stateId: `${base}.heating` },
			icon: icon('fire', 'inactive'),
			iconOn: icon('fire', 'warning'),
			label: { en: 'Heating', de: 'Heizen' },
			tooltip: { en: 'Floor heating', de: 'Fußbodenheizung' },
			levels: [
				{ value: true, text: { en: 'Heating', de: 'Heizt' } },
				{ value: false, text: { en: 'Off', de: 'Aus' } },
			],
			hideIfEmpty: false,
			order: 20,
			configurable: true,
		},
		{
			id: 'roomTemperature',
			value: { stateId: `${base}.temperature.room` },
			icon: icon('thermometer', 'ok'),
			showValue: true,
			unit: ' °C',
			label: { en: 'Room temperature', de: 'Raumtemperatur' },
			tooltip: { en: 'Room temperature', de: 'Raumtemperatur' },
			order: 30,
			configurable: true,
		},
		{
			id: 'floorTemperature',
			value: { stateId: `${base}.temperature.floor` },
			icon: icon('floor', 'ok'),
			showValue: true,
			unit: ' °C',
			label: { en: 'Floor temperature', de: 'Bodentemperatur' },
			tooltip: { en: 'Floor temperature', de: 'Bodentemperatur' },
			order: 40,
			configurable: true,
		},
		{
			id: 'setpoint',
			value: { stateId: `${base}.setpoint.active` },
			icon: icon('target', 'warning'),
			showValue: true,
			unit: ' °C',
			label: { en: 'Setpoint', de: 'Sollwert' },
			tooltip: {
				en: 'Setpoint of the active mode',
				de: 'Sollwert des aktiven Modus',
			},
			order: 45,
			configurable: true,
		},
		{
			id: 'regulationMode',
			value: { stateId: `${base}.regulationMode` },
			icon: icon('mode', 'info'),
			label: { en: 'Regulation mode', de: 'Regelmodus' },
			tooltip: { en: 'Regulation mode', de: 'Regelmodus' },
			levels: [
				...Object.entries(MODE_TEXT).map(([value, text]) => ({ value: Number(value), text })),
				{ text: { en: 'Unknown', de: 'Unbekannt' } },
			],
			order: 50,
			configurable: true,
		},
		{
			id: 'vacation',
			value: { stateId: `${base}.vacation.enabled` },
			icon: icon('flight', 'info'),
			label: { en: 'Vacation', de: 'Urlaub' },
			tooltip: { en: 'Vacation planned or active', de: 'Urlaub geplant oder aktiv' },
			order: 60,
			configurable: true,
		},
	);
	// In local-only mode the cloud gets no data from the thermostat, so its
	// energy values stand still; the estimate from heating time x load counts.
	const estimated = {
		id: 'energyEstimated',
		value: { stateId: `${base}.energy.estimatedToday` },
		icon: icon('bolt', 'warning'),
		showValue: true,
		unit: ' kWh',
		label: { en: 'Energy (estimated)', de: 'Energie (geschätzt)' },
		tooltip: {
			en: 'Energy today, estimated from heating time x load',
			de: 'Energie heute, geschätzt aus Heizzeit × Heizlast',
		},
		order: 71,
		configurable: true,
	};
	if (opts.mode === 'local') {
		list.push(estimated);
	} else {
		list.push({
			id: 'energy',
			value: { stateId: `${base}.energy.value0` },
			icon: icon('bolt', 'warning'),
			showValue: true,
			unit: ' kWh',
			label: { en: 'Energy', de: 'Energie' },
			tooltip: { en: 'Energy (cloud, current period)', de: 'Energie (Cloud, aktueller Zeitraum)' },
			order: 70,
			configurable: true,
		});
		if (opts.mode === 'relay') {
			list.push({ ...estimated, defaultVisible: false });
		}
	}
	return list;
}

/**
 * Indicators of the instance toolbar.
 *
 * @param {string} ns adapter namespace
 * @param {{local: boolean, mode?: string}} opts whether local control is enabled, and the local mode
 * @returns {import('@iobroker/dm-utils').StatusIndicator[]} indicators
 */
function instanceIndicators(ns, opts) {
	/** @type {import('@iobroker/dm-utils').StatusIndicator[]} */
	const list = [
		{
			id: 'cloud',
			value: { stateId: `${ns}.info.connection` },
			icon: icon('cloud', 'error'),
			iconOn: icon('cloud', 'ok'),
			label: { en: 'Cloud', de: 'Cloud' },
			tooltip: { en: 'Connection to the OJ cloud', de: 'Verbindung zur OJ-Cloud' },
			hideIfEmpty: false,
			order: 10,
		},
	];
	if (opts.local) {
		list.push({
			id: 'localGateway',
			value: { stateId: `${ns}.info.localThermostats` },
			icon: icon('home', 'error'),
			showValue: true,
			label: { en: 'Local gateway', de: 'Lokales Gateway' },
			tooltip: { en: 'Thermostats connected to the local gateway', de: 'Lokal verbundene Thermostate' },
			// first match wins: connected thermostats (count shown), listening only, not running
			levels: [
				{ min: 1, icon: icon('home', 'ok') },
				{ value: 0, icon: icon('home', 'warning'), text: { en: 'No thermostat', de: 'Kein Thermostat' } },
				{ icon: icon('home', 'error'), text: { en: 'Off', de: 'Aus' } },
			],
			hideIfEmpty: false,
			order: 20,
		});
		// only relay talks to the vendor gateway
		if (opts.mode === 'relay') {
			list.push({
				id: 'vendorGateway',
				value: { stateId: `${ns}.info.localUpstreamStatus` },
				icon: icon('relay', 'inactive'),
				label: { en: 'Vendor gateway', de: 'Hersteller-Gateway' },
				tooltip: { en: 'Vendor gateway (relay)', de: 'Hersteller-Gateway (Relay)' },
				levels: [
					{ value: 'connected', icon: icon('relay', 'ok'), text: { en: 'Relay', de: 'Relay' } },
					{
						value: 'unreachable',
						icon: icon('relay', 'warning'),
						text: { en: 'Unreachable', de: 'Nicht erreichbar' },
					},
					{
						value: 'untrusted',
						icon: icon('relay', 'error'),
						text: { en: 'Untrusted', de: 'Nicht vertraut' },
					},
				],
				order: 30,
			});
		}
	}
	return list;
}

module.exports = { thermostatIndicators, instanceIndicators, icon };
