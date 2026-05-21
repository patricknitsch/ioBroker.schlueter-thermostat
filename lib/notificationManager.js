'use strict';

// ============================================================================
// Notification Manager
// Dispatches messages to configured providers (Telegram, Pushover, WhatsApp,
// Email, Signal, Matrix, Synology Chat) via adapter.sendToAsync / setForeignStateAsync.
//
// Instance resolution:
//   1. If the user configured a specific instance via the admin UI, use it.
//   2. Otherwise fall back to auto-detecting the first alive instance.
// ============================================================================

/**
 * Returns the instance ID (e.g. "telegram.0") of the first alive instance of
 * the given adapter name, or null if none found.
 *
 * @param {object} adapter
 * @param {string} adapterName  e.g. "telegram"
 * @returns {Promise<string|null>} Instance ID when found; otherwise null.
 */
async function getAliveInstanceId(adapter, adapterName) {
	try {
		const states = await adapter.getForeignStatesAsync(`system.adapter.${adapterName}.*.alive`);
		const aliveKey = Object.keys(states)
			.filter(k => states[k] && states[k].val === true)
			.sort((a, b) => {
				const aMatch = a.match(/\.(\d+)\.alive$/);
				const bMatch = b.match(/\.(\d+)\.alive$/);
				const aNum = aMatch ? Number(aMatch[1]) : Number.MAX_SAFE_INTEGER;
				const bNum = bMatch ? Number(bMatch[1]) : Number.MAX_SAFE_INTEGER;
				if (aNum !== bNum) {
					return aNum - bNum;
				}
				return a.localeCompare(b);
			})[0];
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
 * Resolves the instance ID to use for the given provider:
 *   - If `configuredId` is a non-empty string (set via instance selector), use it.
 *   - Otherwise auto-detect the first alive instance.
 *
 * @param {object} adapter
 * @param {string} adapterName   e.g. "telegram"
 * @param {string} configuredId  value from config (e.g. "telegram.0" or "")
 * @returns {Promise<string|null>}
 */
async function resolveInstance(adapter, adapterName, configuredId) {
	if (configuredId && typeof configuredId === 'string' && configuredId.trim() !== '') {
		return configuredId.trim();
	}
	return getAliveInstanceId(adapter, adapterName);
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
			const instanceId = await resolveInstance(adapter, 'telegram', cfg.notifyInstanceTelegram);
			if (instanceId) {
				const payload = { text };
				if (cfg.notifyUserTelegram) {
					payload.user = cfg.notifyUserTelegram;
				}
				await adapter.sendToAsync(instanceId, 'send', payload);
				adapter.log.debug(`Notification sent via Telegram (${instanceId})`);
			} else {
				adapter.log.warn('sendNotification: no telegram instance found/configured.');
			}
		} catch (e) {
			adapter.log.warn(`sendNotification Telegram error: ${e?.message || e}`);
		}
	}

	// ── Pushover ──────────────────────────────────────────────────────────────
	if (cfg.notifyUsePushover) {
		try {
			const instanceId = await resolveInstance(adapter, 'pushover', cfg.notifyInstancePushover);
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
				adapter.log.warn('sendNotification: no pushover instance found/configured.');
			}
		} catch (e) {
			adapter.log.warn(`sendNotification Pushover error: ${e?.message || e}`);
		}
	}

	// ── WhatsApp (whatsapp-cmb) ───────────────────────────────────────────────
	if (cfg.notifyUseWhatsapp) {
		try {
			const instanceId = await resolveInstance(adapter, 'whatsapp-cmb', cfg.notifyInstanceWhatsapp);
			if (instanceId) {
				const payload = { text };
				if (cfg.notifyPhoneWhatsapp) {
					payload.phone = cfg.notifyPhoneWhatsapp;
				}
				await adapter.sendToAsync(instanceId, 'send', payload);
				adapter.log.debug(`Notification sent via WhatsApp (${instanceId})`);
			} else {
				adapter.log.warn('sendNotification: no whatsapp-cmb instance found/configured.');
			}
		} catch (e) {
			adapter.log.warn(`sendNotification WhatsApp error: ${e?.message || e}`);
		}
	}

	// ── Email ─────────────────────────────────────────────────────────────────
	if (cfg.notifyUseEmail) {
		try {
			const instanceId = await resolveInstance(adapter, 'email', cfg.notifyInstanceEmail);
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
				adapter.log.warn('sendNotification: no email instance found/configured.');
			}
		} catch (e) {
			adapter.log.warn(`sendNotification Email error: ${e?.message || e}`);
		}
	}

	// ── Signal (signal-cmb) ───────────────────────────────────────────────────
	if (cfg.notifyUseSignal) {
		try {
			const instanceId = await resolveInstance(adapter, 'signal-cmb', cfg.notifyInstanceSignal);
			if (instanceId) {
				const payload = { text };
				if (cfg.notifyPhoneSignal) {
					payload.phone = cfg.notifyPhoneSignal;
				}
				await adapter.sendToAsync(instanceId, 'send', payload);
				adapter.log.debug(`Notification sent via Signal (${instanceId})`);
			} else {
				adapter.log.warn('sendNotification: no signal-cmb instance found/configured.');
			}
		} catch (e) {
			adapter.log.warn(`sendNotification Signal error: ${e?.message || e}`);
		}
	}

	// ── Matrix (matrix-org) ───────────────────────────────────────────────────
	if (cfg.notifyUseMatrix) {
		try {
			const instanceId = await resolveInstance(adapter, 'matrix-org', cfg.notifyInstanceMatrix);
			if (instanceId) {
				await adapter.sendToAsync(instanceId, 'send', { text });
				adapter.log.debug(`Notification sent via Matrix (${instanceId})`);
			} else {
				adapter.log.warn('sendNotification: no matrix-org instance found/configured.');
			}
		} catch (e) {
			adapter.log.warn(`sendNotification Matrix error: ${e?.message || e}`);
		}
	}

	// ── Synology Chat (synochat) ──────────────────────────────────────────────
	if (cfg.notifyUseSynoChat) {
		try {
			const instanceId = await resolveInstance(adapter, 'synochat', cfg.notifyInstanceSynoChat);
			if (instanceId) {
				const channel = cfg.notifyChannelSynoChat;
				if (channel) {
					await adapter.setForeignStateAsync(`${instanceId}.${channel}.message`, text);
				} else {
					await adapter.setForeignStateAsync(`${instanceId}.#.message`, text);
				}
				adapter.log.debug(`Notification sent via Synology Chat (${instanceId})`);
			} else {
				adapter.log.warn('sendNotification: no synochat instance found/configured.');
			}
		} catch (e) {
			adapter.log.warn(`sendNotification Synology Chat error: ${e?.message || e}`);
		}
	}
}

module.exports = { sendNotification };
