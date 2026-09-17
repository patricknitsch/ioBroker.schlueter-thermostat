'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = __dirname;
const ioPackage = require(path.join(repoRoot, 'io-package.json'));

describe('logo asset', () => {
	it('uses a .jpg filename consistently for the JPEG logo asset', () => {
		assert.equal(ioPackage.common.icon, 'schlueter-thermostat.jpg');
		assert.equal(
			ioPackage.common.extIcon,
			'https://raw.githubusercontent.com/patricknitsch/ioBroker.schlueter-thermostat/main/admin/schlueter-thermostat.jpg',
		);

		const logoPath = path.join(repoRoot, 'admin', ioPackage.common.icon);
		assert.equal(fs.existsSync(logoPath), true);

		const logo = fs.readFileSync(logoPath);
		assert.equal(logo[0], 0xff);
		assert.equal(logo[1], 0xd8);
		assert.equal(logo[2], 0xff);

		const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
		assert.match(readme, /admin\/schlueter-thermostat\.jpg/);
		assert.doesNotMatch(readme, /admin\/schlueter-thermostat\.png/);
	});
});
