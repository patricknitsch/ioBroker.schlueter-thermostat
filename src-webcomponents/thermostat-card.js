// Web component <schlueter-thermostat-card>: one thermostat as a card in the
// look of the Device Manager card (same icons and indicators), with the
// controls of the details view. Bundled by tasks/build-webcomponents.mjs into
// admin/webcomponents/thermostat-card.js; its manifest is next to it.
//
// Writes go through the apply concept like every other UI: the values into
// apply.<mode>.*, then apply.<mode>.apply = true.

import { IobWebComponent, defineWebComponent } from '@iobroker/web-components/element';
import { svg } from '../lib/icons.js';

const ADAPTER = 'schlueter-thermostat';
const TAG = 'schlueter-thermostat-card';
const STEP = 0.5;
const MIN_SETPOINT = 5;
const MAX_SETPOINT = 35;
/** The manual setpoint is sent once the user stopped clicking -/+ */
const STEP_DEBOUNCE_MS = 1500;
/** How long a mode button shows that it is being sent */
const BUSY_MS = 2500;

/** States of a thermostat the card shows, relative to the device */
const STATES = [
	'online',
	'heating',
	'thermostatName',
	'connection',
	'temperature.room',
	'temperature.floor',
	'setpoint.active',
	'setpoint.manual',
	'setpoint.comfort',
	'regulationMode',
	'endTime.comfort',
	'endTime.boost',
	'vacation.enabled',
	'vacation.begin',
	'vacation.end',
	'energy.value0',
	'energy.estimatedToday',
	'apply.manual.setpoint',
	'apply.comfort.setpoint',
	'apply.comfort.durationMinutes',
	'apply.boost.durationMinutes',
	'apply.vacation.enabled',
	'apply.vacation.begin',
	'apply.vacation.end',
];

/** Shown in the editor of a host while no thermostat is chosen */
const SAMPLE = {
	online: true,
	heating: true,
	thermostatName: 'Bathroom',
	connection: 'relay',
	'temperature.room': 21.4,
	'temperature.floor': 24.6,
	'setpoint.active': 23,
	'setpoint.manual': 23,
	'setpoint.comfort': 24,
	regulationMode: 1,
	'vacation.enabled': false,
	'energy.value0': 3.2,
};

const T = {
	schedule: { en: 'Schedule', de: 'Zeitplan' },
	comfort: { en: 'Comfort', de: 'Komfort' },
	manual: { en: 'Manual', de: 'Manuell' },
	vacation: { en: 'Vacation', de: 'Urlaub' },
	frost: { en: 'Frost protection', de: 'Frostschutz' },
	boost: { en: 'Boost', de: 'Boost' },
	eco: { en: 'Eco', de: 'Eco' },
	unknown: { en: 'Unknown', de: 'Unbekannt' },
	online: { en: 'Online', de: 'Online' },
	offline: { en: 'Offline', de: 'Offline' },
	cloud: { en: 'Cloud', de: 'Cloud' },
	relay: { en: 'Relay', de: 'Relay' },
	local: { en: 'Local', de: 'Lokal' },
	heating: { en: 'Heating', de: 'Heizt' },
	idle: { en: 'Not heating', de: 'Heizt nicht' },
	room: { en: 'Room', de: 'Raum' },
	floor: { en: 'Floor', de: 'Boden' },
	setpoint: { en: 'Setpoint', de: 'Sollwert' },
	energy: { en: 'Energy', de: 'Energie' },
	until: { en: 'until', de: 'bis' },
	lower: { en: 'Lower the setpoint (manual mode)', de: 'Sollwert senken (manueller Modus)' },
	raise: { en: 'Raise the setpoint (manual mode)', de: 'Sollwert erhöhen (manueller Modus)' },
	duration: { en: 'Duration (min)', de: 'Dauer (min)' },
	active: { en: 'Active', de: 'Aktiv' },
	begin: { en: 'Begin (YYYY-MM-DD)', de: 'Beginn (JJJJ-MM-TT)' },
	end: { en: 'End (YYYY-MM-DD)', de: 'Ende (JJJJ-MM-TT)' },
	thermostat: { en: 'Thermostat', de: 'Thermostat' },
	group: { en: 'Group', de: 'Gruppe' },
	serial: { en: 'Serial number', de: 'Seriennummer' },
	serialShort: { en: 'SN', de: 'SN' },
	noThermostat: { en: 'No thermostat found', de: 'Kein Thermostat gefunden' },
	readOnly: {
		en: 'Thermostat offline – controls disabled',
		de: 'Thermostat offline – Steuerung gesperrt',
	},
};

/** Regulation modes: number on the thermostat → text and icon */
const MODES = {
	1: { text: T.schedule, icon: 'schedule' },
	2: { text: T.comfort, icon: 'comfort' },
	3: { text: T.manual, icon: 'manual' },
	4: { text: T.vacation, icon: 'flight' },
	6: { text: T.frost, icon: 'frost' },
	8: { text: T.boost, icon: 'rocket' },
	9: { text: T.eco, icon: 'eco' },
};

/** Mode buttons: apply folder, mode number it leads to, icon */
const BUTTONS = [
	{ apply: 'schedule', mode: 1, icon: 'schedule', text: T.schedule },
	{ apply: 'eco', mode: 9, icon: 'eco', text: T.eco },
	{ apply: 'comfort', mode: 2, icon: 'comfort', text: T.comfort },
	{ apply: 'manual', mode: 3, icon: 'manual', text: T.manual },
	{ apply: 'boost', mode: 8, icon: 'rocket', text: T.boost },
	{ apply: 'vacation', mode: 4, icon: 'flight', text: T.vacation },
];

const ICON_URL = new URL('../schlueter-thermostat.jpg', import.meta.url).href;

const STYLE = `
:host { display: block; width: 100%; height: 100%; }
* { box-sizing: border-box; }
.card {
	container-type: size;
	width: 100%; height: 100%;
	display: flex; flex-direction: column;
	overflow: hidden;
	background: var(--iob-paper);
	color: var(--iob-text);
	font-family: var(--iob-font-family);
	font-size: var(--iob-font-size);
	border: 1px solid var(--iob-divider);
	border-radius: calc(var(--iob-border-radius) * 2);
}
.header {
	display: flex; align-items: center; gap: 12px;
	padding: 10px 12px;
	background: var(--iob-primary); color: var(--iob-primary-contrast);
}
.header.offline { background: #f44336; color: #fff; }
.header img { width: 44px; height: 44px; border-radius: 50%; object-fit: cover; background: #fff; flex: none; }
.title { flex: 1; min-width: 0; }
.name { font-size: 1.15em; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sub { font-size: .85em; opacity: .85; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.id { font-weight: 400; opacity: .85; }
.status { display: flex; align-items: center; gap: 6px; font-size: .85em; flex: none; }
.dot { width: 10px; height: 10px; border-radius: 50%; background: #4caf50; box-shadow: 0 0 0 2px rgba(255,255,255,.7); }
.offline .dot { background: #9e9e9e; }
.indicators {
	display: flex; flex-wrap: wrap; gap: 4px 12px;
	padding: 8px 12px; border-bottom: 1px solid var(--iob-divider);
	font-size: .9em;
}
.ind { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.ind svg, .btn svg, .step svg { width: 18px; height: 18px; flex: none; }
.body { flex: 1; min-height: 0; overflow: auto; padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 10px; }
.temps { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.big { font-size: 2.6em; font-weight: 300; line-height: 1; }
.big small { font-size: .45em; color: var(--iob-text-secondary); margin-left: 2px; }
.label { font-size: .8em; color: var(--iob-text-secondary); text-transform: uppercase; letter-spacing: .04em; }
.stepper { display: flex; align-items: center; gap: 8px; }
.target { text-align: center; min-width: 76px; }
.target .value { font-size: 1.5em; font-weight: 600; color: var(--iob-primary); }
.target.pending .value { opacity: .6; }
.step {
	width: 36px; height: 36px; border-radius: 50%;
	border: 1px solid var(--iob-primary); background: transparent; color: var(--iob-primary);
	font-size: 1.4em; line-height: 1; cursor: pointer; font-family: inherit;
}
.heat { display: inline-flex; align-items: center; gap: 4px; font-size: .9em; color: var(--iob-text-secondary); }
.heat svg { width: 16px; height: 16px; }
.modes { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.btn {
	display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
	padding: 6px 4px; min-height: 52px;
	border: 1px solid var(--iob-divider); border-radius: var(--iob-border-radius);
	background: transparent; color: var(--iob-text);
	font-family: inherit; font-size: .85em; cursor: pointer;
}
.btn svg path { fill: currentColor; }
.btn.active { background: var(--iob-primary); color: var(--iob-primary-contrast); border-color: var(--iob-primary); }
.btn.busy { animation: pulse 1s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: .5; } }
button:disabled { cursor: default; opacity: .45; }
.info { font-size: .85em; color: var(--iob-text-secondary); display: flex; flex-wrap: wrap; gap: 4px 12px; }
.hint { font-size: .85em; color: var(--iob-warning); }
.empty { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--iob-text-secondary); }
.edit button { pointer-events: none; }
@container (max-height: 360px) { .indicators { display: none; } }
@container (max-height: 300px) { .modes { display: none; } }
@container (max-width: 300px) {
	.btn span { display: none; }
	.btn { min-height: 36px; }
	.big { font-size: 2em; }
}
`;

/**
 * @param {unknown} value text
 * @returns {string} HTML-escaped text
 */
function esc(value) {
	return String(value ?? '').replace(
		/[&<>"']/g,
		c =>
			/** @type {Record<string, string>} */ ({
				'&': '&amp;',
				'<': '&lt;',
				'>': '&gt;',
				'"': '&quot;',
				"'": '&#39;',
			})[c],
	);
}

/**
 * @param {unknown} value number or anything
 * @returns {number | null} finite number or null
 */
function num(value) {
	const n = typeof value === 'number' ? value : value === null || value === '' ? NaN : Number(value);
	return Number.isFinite(n) ? n : null;
}

/**
 * @param {string} base full id of a thermostat device
 * @returns {{groupId: string, thermostatId: string}} numbers of group and thermostat from the object id
 */
function idsOf(base) {
	const m = base.match(/\.groups\.([^.]+)\.thermostats\.([^.]+)$/);
	return { groupId: m?.[1] || '', thermostatId: m?.[2] || '' };
}

/**
 * @param {string} base full id of a thermostat device
 * @returns {string} id of its group folder
 */
function groupOf(base) {
	return base.replace(/\.thermostats\.[^.]+$/, '');
}

class ThermostatCard extends IobWebComponent {
	/** @type {string} thermostat found without a setting: the first of the instance */
	#autoBase = '';

	/** @type {string} instance the automatic search ran for */
	#searched = '';

	/** @type {number | null} manual setpoint chosen with -/+ but not sent yet */
	#pending = null;

	/** @type {ReturnType<typeof setTimeout> | undefined} */
	#pendingTimer;

	/** @type {string} apply folder being sent */
	#busy = '';

	/** @type {ReturnType<typeof setTimeout> | undefined} */
	#busyTimer;

	constructor() {
		super();
		const root = this.attachShadow({ mode: 'open' });
		root.innerHTML = `<style>${STYLE}</style><div class="card"></div>`;
		root.addEventListener('click', e => this.#onClick(/** @type {Event} */ (e)));
	}

	disconnectedCallback() {
		super.disconnectedCallback();
		clearTimeout(this.#pendingTimer);
		clearTimeout(this.#busyTimer);
		this.#pending = null;
		this.#busy = '';
	}

	/** @returns {string} instance of the settings, `schlueter-thermostat.0` if none */
	get #instance() {
		const instance = String(this.settings.instance || '').replace(/^system\.adapter\./, '');
		return instance || `${ADAPTER}.0`;
	}

	/** @returns {string} full id of the thermostat device, empty while unknown */
	get #base() {
		return String(this.settings.thermostat || '') || this.#autoBase;
	}

	/**
	 * @param {Record<string, unknown>} settings settings of the host
	 * @returns {string[]} states of the thermostat
	 */
	getStateIds(settings) {
		const base = String(settings.thermostat || '') || this.#autoBase;
		return base ? STATES.map(s => `${base}.${s}`) : [];
	}

	/**
	 * @param {Record<string, unknown>} settings settings of the host
	 * @returns {string[]} the device and its group, for their names
	 */
	getObjectIds(settings) {
		const base = String(settings.thermostat || '') || this.#autoBase;
		return base ? [base, groupOf(base)] : [];
	}

	/** Without a chosen thermostat, take the first one of the instance */
	#findThermostat() {
		const instance = this.#instance;
		if (!this.socket || this.settings.thermostat || this.#searched === instance) {
			return;
		}
		this.#searched = instance;
		this.socket
			.getObjectViewSystem('device', `${instance}.groups.`, `${instance}.groups.香`)
			.then(devices => {
				const ids = Object.keys(devices || {})
					.filter(id => /\.thermostats\.[^.]+$/.test(id))
					.sort();
				if (ids[0] && this.#instance === instance) {
					this.#autoBase = ids[0];
					// the setter subscribes the states of the new thermostat
					this.settings = { ...this.settings };
				}
			})
			.catch(() => {});
	}

	/**
	 * @param {string} state state id relative to the thermostat
	 * @returns {unknown} its value; sample data in the editor
	 */
	#val(state) {
		const base = this.#base;
		if (!base) {
			return /** @type {Record<string, unknown>} */ (SAMPLE)[state];
		}
		return this.states[`${base}.${state}`]?.val;
	}

	/**
	 * @param {unknown} value temperature
	 * @returns {string} formatted with one decimal, `–` if unknown
	 */
	#temp(value) {
		const n = num(value);
		if (n === null) {
			return '–';
		}
		return n.toLocaleString(this.systemLang, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
	}

	/** @returns {boolean} the thermostat takes commands (adapter blocks them while offline in the cloud) */
	#writable() {
		if (this.editMode || !this.socket || !this.#base) {
			return false;
		}
		const connection = this.#val('connection');
		return this.#val('online') !== false || connection === 'relay' || connection === 'local';
	}

	render() {
		const card = /** @type {HTMLElement} */ (this.shadowRoot?.querySelector('.card'));
		this.#findThermostat();
		const base = this.#base;
		// no thermostat and not in the editor: say so instead of showing made-up values
		if (!base && this.socket && !this.editMode) {
			card.className = 'card';
			card.innerHTML = `<div class="empty">${esc(this.text(T.noThermostat))}</div>`;
			return;
		}
		const writable = this.#writable();
		const online = this.#val('online') !== false;
		const mode = num(this.#val('regulationMode'));
		const heating = this.#val('heating') === true;
		const connection = String(this.#val('connection') || 'cloud');
		const deviceName = this.text(/** @type {any} */ (this.objects[base]?.common?.name));
		const name = String(this.#val('thermostatName') || deviceName || 'Thermostat');
		const group = base ? this.text(/** @type {any} */ (this.objects[groupOf(base)]?.common?.name)) : 'Ground floor';
		// the numbers of the cloud as the device object has them; the object id only as fallback
		const native = /** @type {Record<string, unknown>} */ (this.objects[base]?.native || {});
		const ids = base ? idsOf(base) : { groupId: '101254', thermostatId: '258188' };
		const thermostatId = String(native.thermostatId ?? ids.thermostatId);
		const groupId = String(native.groupId ?? ids.groupId);
		const serial = native.serialNumber ? String(native.serialNumber) : base ? '' : '1013W220';
		const tooltip = [
			`${this.text(T.thermostat)}: ${thermostatId}`,
			`${this.text(T.group)}: ${groupId}`,
			serial ? `${this.text(T.serial)}: ${serial}` : '',
		]
			.filter(Boolean)
			.join('\n');
		const setpoint = this.#pending ?? num(this.#val('setpoint.active'));
		const modeInfo = mode !== null ? MODES[/** @type {keyof MODES} */ (mode)] : undefined;
		const energy = num(
			connection === 'local' && num(this.#val('energy.estimatedToday')) !== null
				? this.#val('energy.estimatedToday')
				: this.#val('energy.value0'),
		);

		const connIcon = connection === 'local' ? 'home' : connection === 'relay' ? 'relay' : 'cloud';
		const connColor = connection === 'cloud' ? 'info' : 'ok';
		const indicators = [
			[svg(connIcon, connColor), this.text(T[/** @type {'cloud'} */ (connection)] || T.cloud)],
			[svg('fire', heating ? 'warning' : 'inactive'), this.text(heating ? T.heating : T.idle)],
			[svg('thermometer', 'ok'), `${this.#temp(this.#val('temperature.room'))} °C`],
			[svg('floor', 'ok'), `${this.#temp(this.#val('temperature.floor'))} °C`],
			[svg('target', 'warning'), `${this.#temp(this.#val('setpoint.active'))} °C`],
			[svg('mode', 'info'), this.text(modeInfo?.text || T.unknown)],
		];
		if (this.#val('vacation.enabled') === true) {
			indicators.push([svg('flight', 'info'), this.text(T.vacation)]);
		}
		if (energy !== null) {
			indicators.push([
				svg('bolt', 'warning'),
				`${energy.toLocaleString(this.systemLang, { maximumFractionDigits: 2 })} kWh`,
			]);
		}

		const info = [];
		const until = mode === 2 ? this.#val('endTime.comfort') : mode === 8 ? this.#val('endTime.boost') : '';
		if (until) {
			info.push(`${this.text(modeInfo?.text)} ${this.text(T.until)} ${esc(this.#time(until))}`);
		}
		if (this.#val('vacation.enabled') === true && this.#val('vacation.begin')) {
			info.push(
				`${svg('flight', 'info')} ${esc(this.#val('vacation.begin'))} – ${esc(this.#val('vacation.end'))}`,
			);
		}

		const dis = writable ? '' : 'disabled';
		card.className = `card${this.editMode ? ' edit' : ''}`;
		card.innerHTML = `
			<div class="header${online ? '' : ' offline'}">
				<img src="${ICON_URL}" alt="">
				<div class="title">
					<div class="name" title="${esc(`${name}\n${tooltip}`)}">${esc(name)}${thermostatId ? ` <span class="id">(${esc(thermostatId)})</span>` : ''}</div>
					<div class="sub" title="${esc(tooltip)}">${esc(group || this.text(T.group))}${groupId ? ` (${esc(groupId)})` : ''}${serial ? ` · ${esc(this.text(T.serialShort))} ${esc(serial)}` : ''}</div>
				</div>
				<div class="status"><span class="dot"></span>${esc(this.text(online ? T.online : T.offline))}</div>
			</div>
			<div class="indicators">
				${indicators.map(([icon, text]) => `<span class="ind">${icon}${esc(text)}</span>`).join('')}
			</div>
			<div class="body">
				<div class="temps">
					<div>
						<div class="label">${esc(this.text(T.room))}</div>
						<div class="big">${this.#temp(this.#val('temperature.room'))}<small>°C</small></div>
						<div class="heat">${svg('floor', 'ok')}${esc(this.text(T.floor))} ${this.#temp(this.#val('temperature.floor'))} °C</div>
					</div>
					<div class="stepper">
						<button class="step" data-step="-1" title="${esc(this.text(T.lower))}" ${dis}>−</button>
						<div class="target${this.#pending !== null ? ' pending' : ''}">
							<div class="label">${esc(this.text(T.setpoint))}</div>
							<div class="value">${this.#temp(setpoint)} °C</div>
							<div class="heat">${svg('fire', heating ? 'warning' : 'inactive')}${esc(this.text(heating ? T.heating : T.idle))}</div>
						</div>
						<button class="step" data-step="1" title="${esc(this.text(T.raise))}" ${dis}>+</button>
					</div>
				</div>
				<div class="modes">
					${BUTTONS.map(
						b => `<button class="btn${b.mode === mode ? ' active' : ''}${this.#busy === b.apply ? ' busy' : ''}"
							data-apply="${b.apply}" title="${esc(this.text(b.text))}" ${dis}>
							${svg(/** @type {any} */ (b.icon), 'currentColor')}<span>${esc(this.text(b.text))}</span>
						</button>`,
					).join('')}
				</div>
				${info.length ? `<div class="info">${info.map(i => `<span class="ind">${i}</span>`).join('')}</div>` : ''}
				${!writable && base && !this.editMode && this.socket ? `<div class="hint">${esc(this.text(T.readOnly))}</div>` : ''}
			</div>`;
	}

	/**
	 * @param {unknown} value thermostat-local time `YYYY-MM-DDTHH:MM:SS`
	 * @returns {string} `HH:MM`, with the date if it is not today
	 */
	#time(value) {
		const m = String(value).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
		if (!m) {
			return String(value);
		}
		const today = new Date();
		const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
		return m[1] === iso ? m[2] : `${m[1]} ${m[2]}`;
	}

	/** @param {Event} e click somewhere in the card */
	#onClick(e) {
		if (this.editMode || !this.#writable()) {
			return;
		}
		const target = /** @type {HTMLElement} */ (e.target).closest('button');
		if (!target || target.hasAttribute('disabled')) {
			return;
		}
		if (target.dataset.step) {
			this.#step(Number(target.dataset.step));
		} else if (target.dataset.apply) {
			this.#onMode(target.dataset.apply).catch(err => console.warn(`<${TAG}>: ${err}`));
		}
	}

	/** @param {number} direction -1 or 1 */
	#step(direction) {
		const current = this.#pending ?? num(this.#val('setpoint.active')) ?? num(this.#val('setpoint.manual')) ?? 21;
		const next = Math.min(
			MAX_SETPOINT,
			Math.max(MIN_SETPOINT, Math.round(current / STEP) * STEP + direction * STEP),
		);
		this.#pending = next;
		clearTimeout(this.#pendingTimer);
		this.#pendingTimer = setTimeout(() => {
			const value = this.#pending;
			this.#pending = null;
			if (value !== null) {
				this.#apply('manual', { setpoint: value }).catch(err => console.warn(`<${TAG}>: ${err}`));
			}
		}, STEP_DEBOUNCE_MS);
		this.render();
	}

	/**
	 * A mode button: schedule and eco at once, the others after a dialog with their values
	 *
	 * @param {string} apply apply folder
	 */
	async #onMode(apply) {
		const temp = { type: 'number', min: MIN_SETPOINT, max: MAX_SETPOINT, step: STEP };
		const minutes = { type: 'number', min: 1, max: 1440, step: 1 };
		/** @type {{items: Record<string, any>, data: Record<string, unknown>} | null} */
		let form = null;
		if (apply === 'manual') {
			form = {
				items: { setpoint: { ...temp, label: T.setpoint } },
				data: { setpoint: num(this.#val('apply.manual.setpoint')) ?? num(this.#val('setpoint.manual')) ?? 21 },
			};
		} else if (apply === 'comfort') {
			form = {
				items: {
					setpoint: { ...temp, min: 12, label: T.setpoint },
					durationMinutes: { ...minutes, label: T.duration },
				},
				data: {
					setpoint: num(this.#val('apply.comfort.setpoint')) ?? num(this.#val('setpoint.comfort')) ?? 22,
					durationMinutes: num(this.#val('apply.comfort.durationMinutes')) ?? 180,
				},
			};
		} else if (apply === 'boost') {
			form = {
				items: { durationMinutes: { ...minutes, label: T.duration } },
				data: { durationMinutes: num(this.#val('apply.boost.durationMinutes')) ?? 60 },
			};
		} else if (apply === 'vacation') {
			const pick = (/** @type {string} */ key) =>
				this.#val(`apply.vacation.${key}`) ?? this.#val(`vacation.${key}`);
			form = {
				items: {
					enabled: { type: 'checkbox', label: T.active },
					begin: { type: 'text', label: T.begin },
					end: { type: 'text', label: T.end },
				},
				data: {
					enabled: pick('enabled') === true,
					begin: String(pick('begin') || ''),
					end: String(pick('end') || ''),
				},
			};
		}

		/** @type {Record<string, unknown>} */
		let values = {};
		if (form) {
			const button = BUTTONS.find(b => b.apply === apply);
			const result = await this.openDialog({
				title: button?.text || apply,
				form: { type: 'panel', items: form.items },
				data: /** @type {Record<string, string | number | boolean>} */ (form.data),
			});
			if (!result) {
				return;
			}
			// a field left empty keeps the value the adapter already has
			values = Object.fromEntries(Object.entries(result).filter(([, v]) => v !== undefined && v !== ''));
		}
		await this.#apply(apply, values);
	}

	/**
	 * Store the values of a mode and press its apply button
	 *
	 * @param {string} apply apply folder
	 * @param {Record<string, unknown>} values states of the folder
	 */
	async #apply(apply, values) {
		const base = this.#base;
		if (!base || !this.#writable()) {
			return;
		}
		this.#busy = apply;
		clearTimeout(this.#busyTimer);
		this.#busyTimer = setTimeout(() => {
			this.#busy = '';
			this.render();
		}, BUSY_MS);
		this.render();
		for (const [key, val] of Object.entries(values)) {
			await this.setState(`${base}.apply.${apply}.${key}`, /** @type {ioBroker.StateValue} */ (val));
		}
		await this.setState(`${base}.apply.${apply}.apply`, true);
	}
}

defineWebComponent(TAG, ThermostatCard);

export { ThermostatCard };
