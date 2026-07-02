'use strict';

const { expect } = require('chai');
const ioPackage = require('./io-package.json');

describe('io-package news translations', () => {
	it('should keep previously untranslated entries distinct from the English text', () => {
		expect(ioPackage.common.news['0.7.0'].es).to.not.equal(ioPackage.common.news['0.7.0'].en);
		expect(ioPackage.common.news['0.7.2'].es).to.not.equal(ioPackage.common.news['0.7.2'].en);
		expect(ioPackage.common.news['0.7.3'].pl).to.not.equal(ioPackage.common.news['0.7.3'].en);
		expect(ioPackage.common.news['0.7.4'].pl).to.not.equal(ioPackage.common.news['0.7.4'].en);
	});
});
