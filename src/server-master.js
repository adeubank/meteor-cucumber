DEBUG = !!process.env.VELOCITY_DEBUG;

(function () {

  'use strict';

  if (process.env.IS_MIRROR) {
    return;
  }

  var path = Npm.require('path'),
      fs = Npm.require('fs'),
      FRAMEWORK_NAME = 'cucumber',
      FRAMEWORK_REGEX = FRAMEWORK_NAME + '/.+\\.(feature|js|coffee|litcoffee|coffee\\.md)$',
      featuresRelativePath = path.join(FRAMEWORK_NAME, 'features'),
      featuresPath = path.join(_getTestsPath(), featuresRelativePath);


  _registerFramework();

  // Bail if there aren't any features defined yet
  if (!fs.existsSync(featuresPath)) {
    return;
  }

  _setupStarterHooks();
  _setupFinisherHooks();

  function _setupFinisherHooks () {
    // run when all features are not testables (false)
    var debouncedFinisher = _.debounce(Meteor.bindEnvironment(_finisher), 300);
    VelocityTestFiles.find({
      targetFramework: FRAMEWORK_NAME,
      testable: false
    }, {fields: {testable: 1}}).observe({
      added: debouncedFinisher,
      removed: debouncedFinisher,
      changed: debouncedFinisher
    });
  }

  function _finisher () {
    if (VelocityTestFiles.find({targetFramework: FRAMEWORK_NAME, testable: true}).count() === 0) {
      // FIXME need to properly wait for (what?!)
      // FIXME this is happening twice
      Meteor.setTimeout(function () {
        Meteor.call('velocity/reports/completed', {framework: FRAMEWORK_NAME}, function () {
          DEBUG && console.log('[xolvio:cucumber] Completed');
        });
      }, 1000)
    }
  }

  function _setupStarterHooks () {
    // reset testable field on all tests if any framework files change...
    var debouncedStarter = _.debounce(Meteor.bindEnvironment(_starter), 300);
    VelocityTestFiles.find({targetFramework: FRAMEWORK_NAME}, {fields: {testable: 0}}).observe({
      added: debouncedStarter,
      removed: debouncedStarter,
      changed: debouncedStarter
    });
    // ...and if any app client files change (Server chanted will always trigger a reset
    process.on('SIGUSR2', Meteor.bindEnvironment(function () {
      DEBUG && console.log('[xolvio:cucumber] Client restart detected');
      debouncedStarter();
    }));
  }

  // starts mirrors and resets the testable flag on all test files so the worker mirrors can consume the test files as tasks
  function _starter () {

    Meteor.call('velocity/reports/reset', function () {
      VelocityTestFiles.update({absolutePath: /\.feature$/}, {$set: {testable: true}}, {multi: true});
      Meteor.call('velocity/mirrors/request', {
        framework: 'cucumber',
        nodes: process.env.MIRRORS ? parseInt(process.env.MIRRORS) : 1,
        handshake: false
      });
    });
  }

  function _getSampleTestFiles () {
    return [{
      path: path.join(featuresRelativePath, 'sample.feature'),
      contents: Assets.getText(path.join('sample-tests', 'feature.feature'))
    }, {
      path: path.join(featuresRelativePath, 'support', 'hooks.js'),
      contents: Assets.getText(path.join('sample-tests', 'hooks.js'))
    }, {
      path: path.join(featuresRelativePath, 'step_definitions', 'sampleSteps.js'),
      contents: Assets.getText(path.join('sample-tests', 'steps.js'))
    }, {
      path: path.join(featuresRelativePath, 'support', 'world.js'),
      contents: Assets.getText(path.join('sample-tests', 'world.js'))
    }];
  }

  function _getAppPath () {
    return findAppDir();
  }

  function _getTestsPath () {
    return path.join(_getAppPath(), 'tests');
  }

  function _registerFramework () {
    if (Velocity && Velocity.registerTestingFramework) {
      Velocity.registerTestingFramework(FRAMEWORK_NAME, {
        regex: FRAMEWORK_REGEX,
        sampleTestGenerator: _getSampleTestFiles
      });
    }
  }

})();
