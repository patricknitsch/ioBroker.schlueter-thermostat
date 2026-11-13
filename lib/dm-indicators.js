'use strict';

// ============================================================================
// Status indicators for the Device Manager cards (and the instance toolbar).
//
// The indicators read their values live from the thermostat states, so the
// cards follow every change without any action of the adapter. Icons are
// small SVGs (Material Design icon paths) in fixed colours, because a colour
// token does not apply to image icons; levels switch between coloured icons.
// ============================================================================

const COLORS = {
	ok: '#4caf50',
	info: '#2196f3',
	warning: '#ff9800',
	error: '#f44336',
	inactive: '#9e9e9e',
};

const PATHS = {
	thermometer:
		'M15 13V5c0-1.66-1.34-3-3-3S9 3.34 9 5v8c-1.21.91-2 2.37-2 4 0 2.76 2.24 5 5 5s5-2.24 5-5c0-1.63-.79-3.09-2-4zm-4-8c0-.55.45-1 1-1s1 .45 1 1h-1v1h1v2h-1v1h1v2h-2V5z',
	floor: 'M3 18c1.5 0 1.5-1 3-1s1.5 1 3 1 1.5-1 3-1 1.5 1 3 1 1.5-1 3-1 1.5 1 3 1v2c-1.5 0-1.5-1-3-1s-1.5 1-3 1-1.5-1-3-1-1.5 1-3 1-1.5-1-3-1-1.5 1-3 1zM7 3h2v10H7zm4 0h2v10h-2zm4 0h2v10h-2zM3 14h18v2H3z',
	fire: 'M19.48 12.35c-1.57-4.08-7.16-4.3-5.81-10.23.1-.44-.37-.78-.75-.55C9.29 3.71 6.68 8 8.87 13.62c.18.46-.36.89-.75.59-1.81-1.37-2-3.34-1.84-4.75.06-.52-.62-.77-.91-.34C4.69 10.16 4 11.84 4 14.37c.38 5.6 5.11 7.32 6.81 7.54 2.43.31 5.06-.14 6.95-1.87 2.08-1.93 2.84-5.01 1.72-7.69zm-9.28 5.03c1.44-.35 2.18-1.39 2.38-2.31.33-1.43-.96-2.83-.09-5.09.33 1.87 3.27 3.04 3.27 5.08.08 2.53-2.66 4.7-5.56 2.32z',
	cloud: 'M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z',
	home: 'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z',
	relay: 'm18 12 4-4-4-4v3H3v2h15zM6 12l-4 4 4 4v-3h15v-2H6z',
	mode: 'M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z',
	bolt: 'M11 21h-1l1-7H7.5c-.58 0-.57-.32-.38-.66.19-.34.05-.08.07-.12C8.48 10.94 10.42 7.54 13 3h1l-1 7h3.5c.49 0 .56.33.47.51l-.07.15C12.96 17.55 11 21 11 21z',
	flight: 'M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z',
};

/**
 * SVG icon as data URI.
 *
 * @param {keyof PATHS} name icon name
 * @param {keyof COLORS} color colour token
 * @returns {string} data URI
 */
function icon(name, color) {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="${COLORS[color]}" d="${PATHS[name]}"/></svg>`;
	return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
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
 * @returns {import('@iobroker/dm-utils').StatusIndicator[]} indicators
 */
function thermostatIndicators(base, opts) {
	/** @type {import('@iobroker/dm-utils').StatusIndicator[]} */
	const list = [];
	if (opts.local) {
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
	}
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
 * @param {{local: boolean}} opts whether local control is enabled
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
		list.push(
			{
				id: 'localGateway',
				value: { stateId: `${ns}.info.localListening` },
				icon: icon('home', 'error'),
				iconOn: icon('home', 'ok'),
				label: { en: 'Local gateway', de: 'Lokales Gateway' },
				tooltip: { en: 'Local gateway listening', de: 'Lokales Gateway aktiv' },
				hideIfEmpty: false,
				order: 20,
			},
			{
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
			},
		);
	}
	return list;
}

module.exports = { thermostatIndicators, instanceIndicators, icon };
