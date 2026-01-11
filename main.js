'use strict';

/*
 * Created with @iobroker/create-adapter v3.1.2
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const axios = require('axios');

// Load your modules here, e.g.:
// const fs = require('fs');

class SchlueterThermostat extends utils.Adapter {
	/**
	 * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
	 */
	constructor(options) {
		super({
			...options,
			name: 'schlueter-thermostat',
		});

		this.sessionToken = null; // Token im Speicher halten
		this.pollingTimer = null;
		this.cloudConnected = false;

		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		// this.on('objectChange', this.onObjectChange.bind(this));
		// this.on('message', this.onMessage.bind(this));
		this.on('unload', this.onUnload.bind(this));
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		if (!this.config.username || !this.config.password) {
			this.log.error(`username and/or password empty - please check instance configuration of ${this.namespace}`);
			return;
		}

		if (!this.config.swversion || !this.config.customerid) {
			this.log.error(
				`swversion and/or customerid empty - please check instance configuration of ${this.namespace}`,
			);
			return;
		}

		// Subscribe to changes of certain states
		this.subscribeStates('*.RegulationMode');
		this.subscribeStates('*.ManualModeSetpoint');
		this.subscribeStates('*.ComfortSetpoint');
		// Set connection state to false
		await this._setCloudConnection(false);
		// Poll Main Data
		await this.pollMainData();
	}

	/**
	 * Login and save Token
	 */
	async _login() {
		const urlMain = 'https://ocd5.azurewebsites.net/api/UserProfile/SignIn';
		const payload = {
			APIKEY: this.config.apikey,
			UserName: this.config.username,
			Password: this.config.password,
			CustomerId: this.config.customerid,
			ClientSWVersion: this.config.swversion,
		};

		try {
			this.log.debug('Try Login...');
			const fetching = await axios.post(urlMain, payload, { timeout: 5000 });

			if (fetching.data && fetching.data.SessionId) {
				this.sessionToken = fetching.data.SessionId;
				this.log.debug(`Login successful, got Session-Token: ${this.sessionToken}`);
				await this._setCloudConnection(true);
				return true;
			}
			return false;
		} catch (error) {
			this.log.error(`Error Login: ${error.message}`);
			await this._setCloudConnection(false);
			return false;
		}
	}

	/**
	 * Main polling function
	 */
	async pollMainData() {
		// Check if we have a valid token
		if (!this.sessionToken) {
			const success = await this._login();
			if (!success) {
				this._scheduleNext(30000); // Retry in 30 seconds
				return;
			}
		}
		try {
			// Fetch Main Data
			const dataUrlMain = `https://ocd5.azurewebsites.net/api/Group/GroupContents?APIKEY=${this.config.apikey}&sessionid=${this.sessionToken}`;
			const fetchingMain = await axios.get(dataUrlMain);

			if (this.cloudConnected && fetchingMain && fetchingMain.status === 200) {
				// Handle Datapoints
				this.log.debug(`Got Data: ${JSON.stringify(fetchingMain.data)}`);
				await this.handleDatapoints(fetchingMain.data);

				// Fetch Energy Data if enabled
				if (this.config.energy) {
					await this.pollEnergyData(fetchingMain.data);
				}
			} else {
				this.log.warn(`Cloud connection failed. Response status: ${fetchingMain.status}`);
			}
		} catch (error) {
			if (error.fetchingMain && error.fetchingMain.status === 401) {
				this.log.warn('Token expired, resetting...');
				this.sessionToken = null; // Delete token to force re-login
			} else {
				this.log.error(`Error fetching Main data: ${error.message}`);
			}
		}

		this._scheduleNext(60000); // Poll every 60 seconds
	}

	/**
	 * Energy polling function
	 *
	 * @param {any} mainData - Main data for reference
	 */
	async pollEnergyData(mainData) {
		// Check if we have a valid token
		if (!this.sessionToken) {
			const success = await this._login();
			if (!success) {
				this._scheduleNext(30000); // Retry in 30 seconds
				return;
			}
		}
		try {
			// Fetch Energy Data
			const dataUrlEnergy = `https://ocd5.azurewebsites.net/api/EnergyUsage/GetEnergyUsage?sessionid=${this.sessionToken}`;
			const dateTomorrow = new Date();
			dateTomorrow.setDate(dateTomorrow.getDate() + 1);
			const payload = {
				APIKEY: this.config.apikey,
				ThermostatID: this.config.swversion,
				ViewType: 2,
				DateTime: dateTomorrow,
				History: 0,
			};
			const fetchingMain = mainData;
			// Fetch Energy Data must run with a separate Post
			const fetchingEnergy = await axios.post(dataUrlEnergy, payload, { timeout: 5000 });

			if (this.cloudConnected && fetchingEnergy && fetchingEnergy.status === 200) {
				// Handle Datapoints
				// Actually not sure, how it looks like with multiple thermostats and Energy Data
				// So far, just handling the first one, needs to be extended later
				this.log.debug(`Got Energy Data: ${JSON.stringify(fetchingEnergy.data)}`);
				const _SerialNumber = fetchingMain.GroupContents[0].Thermostats[0].SerialNumber;
				const _GroupName = fetchingMain.GroupContents[0].GroupName;
				this.log.debug(`Energy Data for Thermostat ${_SerialNumber} in Group ${_GroupName}`);
				const _energyKey = Object.keys(fetchingEnergy.data.EnergyUsage[0].Usage[0])[0];
				const _energyValue = Object.values(fetchingEnergy.data.EnergyUsage[0].Usage[0])[0];
				const _typeValue = typeof _energyValue;
				this.log.debug(`${_energyKey}: ${_energyValue} (Type: ${_typeValue})`);
				const path = `${_GroupName}.${_SerialNumber}`;
				const fullPath = `${path}.${_energyKey}`;
				this.log.debug(`Path: ${fullPath}`);
				// Create object if not exists
				await this._setDatapoints(
					fullPath,
					'state',
					_energyKey,
					_typeValue,
					'value',
					_energyValue,
					true,
					false,
				);
			} else {
				this.log.warn(`Cloud connection failed. Response status: ${fetchingEnergy.status}`);
			}
		} catch (error) {
			if (error.response && error.response.status === 401) {
				this.log.warn('Token expired, resetting...');
				this.sessionToken = null; // Delete token to force re-login
			} else {
				this.log.error(`Error fetching Energy data: ${error.message}`);
			}
		}

		this._scheduleNext(60000); // Poll every 60 seconds
	}

	/**
	 * Set connection state
	 *
	 * @param {boolean} status - Connection status
	 */
	async _setCloudConnection(status) {
		this.cloudConnected = status;
		await this.setStateChangedAsync('info.connection', { val: status, ack: true });
	}

	/**
	 * Delay function
	 *
	 * @param {number} ms - Delay in milliseconds
	 */
	_scheduleNext(ms) {
		this.pollingTimer = this.setTimeout(() => this.pollMainData(), ms);
	}

	/**
	 * Handle Datapoints
	 *
	 * @param {object} response - The response data containing GroupContents
	 *
	 * Structure:
	 * {
	 *   "GroupContents": [
	 *     {
	 *       "GroupName": "LivingRoom",
	 *       "Thermostats": [
	 *         {
	 *           "SerialNumber": "123456",
	 *           "CurrentTemp": 2150,
	 *           "SetTemp": 2200,
	 * 			 "ThermostatName": "Living Room Thermostat",
	 *           "Schedule": {
	 * 				"Days": [
	 * 					{
	 * 						"WeekDayGrpNo": 1,
	 * 						"Events": [
	 * 							{
	 * 								"Time": "06:00",
	 * 								"SetTemp": 2200,
	 *
	 * 							},
	 *         }
	 *       ]
	 *     }
	 *   ]
	 * }
	 */
	async handleDatapoints(response) {
		const MainData = response;
		try {
			// 1. Area: GroupContents Array
			for (let i = 0; i < MainData['GroupContents'].length; i++) {
				const _groupContents = MainData['GroupContents'][i];
				const _groupName = _groupContents['GroupName'];

				// 2. Area: Thermostats Array
				const _Thermostats = _groupContents['Thermostats'];
				for (let j = 0; j < _Thermostats.length; j++) {
					const _ThermostatName = _Thermostats[j];
					const _SerialNumber = _ThermostatName['SerialNumber'];
					const path = `${_groupName}.${_SerialNumber}`;

					// 3. Area: Running through keys of the thermostat object
					for (let _thermostatKey in _ThermostatName) {
						let _thermostatValue = _ThermostatName[_thermostatKey];
						const fullPath = `${path}.${_thermostatKey}`;

						// Only create states for primitive types
						if (typeof _thermostatValue !== 'object') {
							const _typeValue = typeof _thermostatValue;

							// Write value to state
							if (_thermostatKey.includes('Temp') || _thermostatKey.includes('Set')) {
								_thermostatValue = _thermostatValue / 100; // Convert to Celsius
							}
							this.log.debug(`${_thermostatKey}: ${_thermostatValue} (Type: ${_typeValue})`);
							// Create object if not exists
							await this._setDatapoints(
								fullPath,
								'state',
								_thermostatKey,
								_typeValue,
								'value',
								_thermostatValue,
								true,
								false,
							);
							// Create schedule states if enabled
						} else if (
							typeof _thermostatValue === 'object' &&
							_thermostatValue !== null &&
							this.config.schedule
						) {
							let _scheduleDays = _thermostatValue.Days;

							// 4. Area: Loop through days
							for (let k = 0; k < _scheduleDays.length; k++) {
								const _scheduleWeekday = _scheduleDays[k];
								const _scheduleEvent = _scheduleWeekday.Events;
								this.log.debug(`--- Day Group Nr: ${_scheduleWeekday.WeekDayGrpNo} ---`);

								// 5. Area: Loop through events
								for (let l = 0; l < _scheduleEvent.length; l++) {
									const __scheduleEvent = _scheduleEvent[l];
									this.log.debug(`  Result ${l + 0}:`);

									// 6. Area: Loop through event keys
									for (let _eventKey in __scheduleEvent) {
										let _eventValue = __scheduleEvent[_eventKey];

										// Map JavaScript types to ioBroker common types
										const _typeValue = typeof _eventValue;
										const path = `${_groupName}.Schedule.${_scheduleWeekday.WeekDayGrpNo}.Event_${l + 0}`;
										const fullPath = `${path}.${_eventKey}`;

										// Write value to state
										if (_eventKey.includes('Temp') || _eventKey.includes('Set')) {
											_eventValue = _eventValue / 100; // Convert to Celsius
										}
										// Create object if not exists
										await this._setDatapoints(
											fullPath,
											'state',
											_eventKey,
											_typeValue,
											'value',
											_eventValue,
											true,
											false,
										);
										this.log.debug(`    - ${_eventKey}: ${_eventValue}`);
									}
								}
								this.log.debug('\n');
							}
						}
					}
				}
			}
			this.log.debug('JSON successfully processed and datapoints updated.');
		} catch (e) {
			this.log.error(`Error at handling: ${e}`);
		}
	}

	/**
	 * Function Datapoint Handler
	 *
	 * @param {string} id - State ID
	 * @param {'state'} type - Object type
	 * @param {string} _name - State name
	 * @param {any} _type - State type
	 * @param {string} _role - State role
	 * @param {*} _state - State value
	 * @param {boolean} _read - Read permission
	 * @param {boolean} _write - Write permission
	 */
	async _setDatapoints(id, type, _name, _type, _role, _state, _read, _write) {
		try {
			const writeableDP = ['RegulationMode', 'ManualModeSetpoint', 'ComfortSetpoint'];

			if (writeableDP.includes(_name)) {
				_write = true;
			}
			await this.setObjectNotExistsAsync(id, {
				type: type,
				common: {
					name: _name,
					type: _type,
					role: _role,
					read: _read,
					write: _write,
				},
				native: {},
			});
			await this.setStateChangedAsync(id, _state, true);
		} catch (e) {
			this.log.error(`Error at Handling Datapoint ${id}: ${e.message}`);
		}
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 *
	 * @param {() => void} callback - Callback function
	 */
	onUnload(callback) {
		try {
			this.sessionToken = null; // Token im Speicher halten
			this.pollingTimer = null;
			this._setCloudConnection(false);

			callback();
		} catch (error) {
			this.log.error(`Error during unloading: ${error.message}`);
			callback();
		}
	}

	// If you need to react to object changes, uncomment the following block and the corresponding line in the constructor.
	// You also need to subscribe to the objects with `this.subscribeObjects`, similar to `this.subscribeStates`.
	// /**
	//  * Is called if a subscribed object changes
	//  * @param {string} id
	//  * @param {ioBroker.Object | null | undefined} obj
	//  */
	// onObjectChange(id, obj) {
	// 	if (obj) {
	// 		// The object was changed
	// 		this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
	// 	} else {
	// 		// The object was deleted
	// 		this.log.info(`object ${id} deleted`);
	// 	}
	// }

	/**
	 * Is called if a subscribed state changes
	 *
	 * @param {string} id - State ID
	 * @param {ioBroker.State | null | undefined} state - State object
	 */
	onStateChange(id, state) {
		if (state) {
			// The state was changed
			this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);

			if (state.ack === false) {
				// This is a command from the user (e.g., from the UI or other adapter)
				// and should be processed by the adapter
				this.log.info(`User command received for ${id}: ${state.val}`);

				// TODO: Add your control logic here
			}
		} else {
			// The object was deleted or the state value has expired
			this.log.info(`state ${id} deleted`);
		}
	}

	// If you need to accept messages in your adapter, uncomment the following block and the corresponding line in the constructor.
	// /**
	//  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
	//  * Using this method requires "common.messagebox" property to be set to true in io-package.json
	//  * @param {ioBroker.Message} obj
	//  */
	// onMessage(obj) {
	// 	if (typeof obj === 'object' && obj.message) {
	// 		if (obj.command === 'send') {
	// 			// e.g. send email or pushover or whatever
	// 			this.log.info('send command');

	// 			// Send response in callback if required
	// 			if (obj.callback) this.sendTo(obj.from, obj.command, 'Message received', obj.callback);
	// 		}
	// 	}
	// }
}

if (require.main !== module) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
	 */
	module.exports = options => new SchlueterThermostat(options);
} else {
	// otherwise start the instance directly
	new SchlueterThermostat();
}
