(function () {

	'use strict';

	var i, prefixedModules = [],
		config = {
			baseUrl: '../<%= levels %><%= tmpSrcDir %>',
			paths: {
				modules: '../test/modules',
				samples: '../test/samples',
				helpers: '../test/helpers',
				vendor: '../test/vendor'
			}
		};

	if ( /build=true/.test( window.location.search ) || /phantomjs/i.test( window.navigator.userAgent ) ) {
		config.paths.ractive = '../ractive-legacy';
	}

	// required for asyncTest and module('',{setup}) to work
	// see http://stackoverflow.com/questions/17065488/qunit-setup-called-for-each-test-before-teardown
	QUnit.config.autostart = false;
	QUnit.config.reorder = false;
	QUnit.config.testTimeout = 2000;

	// Sauce labs
	var log = [ ];
	var testName;

	QUnit.done(function (test_results) {
		var tests = [ ];
		for (var i = 0, len = log.length; i < len; i++) {
			var details = log[ i ];
			tests.push({
				name: details.name,
				result: details.result,
				expected: details.expected,
				actual: details.actual,
				source: details.source
			});
		}
		test_results.tests = tests;

		window.global_test_results = test_results;
	});

	QUnit.testStart(function (testDetails) {
		QUnit.log(function (details) {
			if (!details.result) {
				details.name = testDetails.name;
				log.push(details);
			}
		});
	});

	require.config( config );

	// can't use .map() because of IE...
	i = _modules.length;
	while ( i-- ) {
		prefixedModules[i] = 'modules/' + _modules[i];
	}

	require( [ 'ractive' ].concat( prefixedModules ), function ( Ractive ) {
		window.Ractive = Ractive;

		Ractive.defaults.magic = /magic=true/.test( window.location.search );

		Array.prototype.slice.call( arguments, 1 ).forEach( function ( testSet ) {
			testSet();
		});

		QUnit.start();

	});

}());
