'use strict';

// ============================================================================
// Notification Manager
// Dispatches messages to configured providers (Telegram, Pushover, WhatsApp,
// Email, Signal, Matrix, Synology Chat) via adapter.sendToAsync / setForeignStateAsync.
// ============================================================================

/**
 * Returns the instance ID (e.g. "telegram.0") of the first alive instance of
 * the given adapter name, or null if none found.
 *
 * @param {object} adapter  ioBroker adapter instance
 * @param {string} adapterName  e.g. "telegram"
 * @returns {Promise<string|null>} Instance ID when found; otherwise null.
 */
async function getAliveInstanceId(adapter, adapterName) {
	try {
		const states = await adapter.getForeignStatesAsync(`system.adapter.${adapterName}.*.alive`);
		const aliveKey = Object.keys(states).find(k => states[k] && states[k].val === true);
		if (!aliveKey) {
			return null;
		}
		return aliveKey.replace(/^system\.adapter\./, '').replace(/\.alive$/, '');
	} catch (e) {
		adapter.log.debug(`getAliveInstanceId(${adapterName}) error: ${e?.message || e}`);
		return null;
	}
}

/**
 * Sends a text notification to all enabled providers.
 *
 * @param {object} adapter  ioBroker adapter instance
 * @param {string} text     Message text to send
 */
async function sendNotification(adapter, text) {
	if (!adapter.config.notifyEnabled) {
		return;
	}

	const cfg = adapter.config;

	// ── Telegram ──────────────────────────────────────────────────────────────
	if (cfg.notifyUseTelegram) {
		try {
			const instanceId = await getAliveInstanceId(adapter, 'telegram');
			if (instanceId) {
				const payload = { text };
				if (cfg.notifyUserTelegram) {
					payload.user = cfg.notifyUserTelegram;
				}
				await adapter.sendToAsync(instanceId, 'send', payload);
				adapter.log.debug(`Notification sent via Telegram (${instanceId})`);
			} else {
				adapter.log.warn('sendNotification: no alive telegram instance found.');
			}
		} catch (e) {
			adapter.log.warn(`sendNotification Telegram error: ${e?.message || e}`);
		}
	}

	// ── Pushover ──────────────────────────────────────────────────────────────
	if (cfg.notifyUsePushover) {
		try {
			const instanceId = await getAliveInstanceId(adapter, 'pushover');
			if (instanceId) {
				const payload = {
					message: text,
					title: cfg.notifyTitlePushover || 'Schlüter Thermostat',
				};
				if (cfg.notifyDevicePushover) {
					payload.device = cfg.notifyDevicePushover;
				}
				await adapter.sendToAsync(instanceId, 'send', payload);
				adapter.log.debug(`Notification sent via Pushover (${instanceId})`);
			} else {
				adapter.log.warn('sendNotification: no alive pushover instance found.');
			}
		} catch (e) {
			adapter.log.warn(`sendNotification Pushover error: ${e?.message || e}`);
		}
	}

	// ── WhatsApp (whatsapp-cmb) ───────────────────────────────────────────────
	if (cfg.notifyUseWhatsapp) {
		try {
			const instanceId = await getAliveInstanceId(adapter, 'whatsapp-cmb');
			if (instanceId) {
				const payload = { text };
				if (cfg.notifyPhoneWhatsapp) {
					payload.phone = cfg.notifyPhoneWhatsapp;
				}
				await adapter.sendToAsync(instanceId, 'send', payload);
				adapter.log.debug(`Notification sent via WhatsApp (${instanceId})`);
			} else {
				adapter.log.warn('sendNotification: no alive whatsapp-cmb instance found.');
			}
		} catch (e) {
			adapter.log.warn(`sendNotification WhatsApp error: ${e?.message || e}`);
		}
	}

	// ── Email ─────────────────────────────────────────────────────────────────
	if (cfg.notifyUseEmail) {
		try {
			const instanceId = await getAliveInstanceId(adapter, 'email');
			if (instanceId) {
				const payload = {
					text,
					subject: cfg.notifyEmailSubject || 'Schlüter Thermostat',
				};
				if (cfg.notifyEmailTo) {
					payload.sendTo = cfg.notifyEmailTo;
				}
				await adapter.sendToAsync(instanceId, 'send', payload);
				adapter.log.debug(`Notification sent via Email (${instanceId})`);
			} else {
				adapter.log.warn('sendNotification: no alive email instance found.');
			}
		} catch (e) {
			adapter.log.warn(`sendNotification Email error: ${e?.message || e}`);
		}
	}

	// ── Signal (signal-cmb) ───────────────────────────────────────────────────
	if (cfg.notifyUseSignal) {
		try {
			const instanceId = await getAliveInstanceId(adapter, 'signal-cmb');
			if (instanceId) {
				const payload = { text };
				if (cfg.notifyPhoneSignal) {
					payload.phone = cfg.notifyPhoneSignal;
				}
				await adapter.sendToAsync(instanceId, 'send', payload);
				adapter.log.debug(`Notification sent via Signal (${instanceId})`);
			} else {
				adapter.log.warn('sendNotification: no alive signal-cmb instance found.');
			}
		} catch (e) {
			adapter.log.warn(`sendNotification Signal error: ${e?.message || e}`);
		}
	}

	// ── Matrix (matrix-org) ───────────────────────────────────────────────────
	if (cfg.notifyUseMatrix) {
		try {
			const instanceId = await getAliveInstanceId(adapter, 'matrix-org');
			if (instanceId) {
				await adapter.sendToAsync(instanceId, 'send', { text });
				adapter.log.debug(`Notification sent via Matrix (${instanceId})`);
			} else {
				adapter.log.warn('sendNotification: no alive matrix-org instance found.');
			}
		} catch (e) {
			adapter.log.warn(`sendNotification Matrix error: ${e?.message || e}`);
		}
	}

	// ── Synology Chat (synochat) ──────────────────────────────────────────────
	if (cfg.notifyUseSynoChat) {
		try {
			const instanceId = await getAliveInstanceId(adapter, 'synochat');
			if (instanceId) {
				const channel = cfg.notifyChannelSynoChat;
				if (channel) {
					await adapter.setForeignStateAsync(`${instanceId}.${channel}.message`, text);
				} else {
					await adapter.setForeignStateAsync(`${instanceId}.#.message`, text);
				}
				adapter.log.debug(`Notification sent via Synology Chat (${instanceId})`);
			} else {
				adapter.log.warn('sendNotification: no alive synochat instance found.');
			}
		} catch (e) {
			adapter.log.warn(`sendNotification Synology Chat error: ${e?.message || e}`);
		}
	}
}

module.exports = { sendNotification };
