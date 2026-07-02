'use strict';

const { expect } = require('chai');
const ioPackage = require('./io-package.json');

describe('io-package news translations', () => {
	it('should keep previously untranslated entries distinct from the English text', () => {
		const fixedTranslations = [
			{ version: '0.7.0', language: 'es' },
			{ version: '0.7.2', language: 'es' },
			{ version: '0.7.3', language: 'pl' },
			{ version: '0.7.4', language: 'pl' },
		];

		for (const { version, language } of fixedTranslations) {
			expect(ioPackage.common.news[version][language]).to.not.equal(ioPackage.common.news[version].en);
		}
	});
});
