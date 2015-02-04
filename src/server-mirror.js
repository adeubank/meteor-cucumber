DEBUG = !!process.env.VELOCITY_DEBUG;
DEBUG = true;

(function () {

  'use strict';

  if (!process.env.IS_MIRROR) {
    return;
  }

  var path = Npm.require('path'),
      fs = Npm.require('fs'),
      FRAMEWORK_NAME = 'cucumber',
      Module = Npm.require('module'),
      // FIXME this is a crude stop method. Needs a better solution
      timeToDie = false;

  var _velocity = DDP.connect(process.env.PARENT_URL);
  var _VelocityTestFiles = new Mongo.Collection('velocityTestFiles', {connection: _velocity});
  _velocity.subscribe('VelocityTestFiles', function () {
    _runCucumber();
  });

  function _runCucumber () {

    console.log('running');

    var feature = _getNextFeature();
    if (!feature) {
      console.log('Nothing to do, exiting');
      process.exit(0);
    }

    // iterate through all feature files and run each test in oder and synchronously
    while (feature) {

      // FIXME this is not really detecting the master process restarting, so mirrors keep running
      // need a surer way to stop mirrors
      if (_velocity.status().status !== 'connected') {
        DEBUG && console.log('Connection lost to master process, aborting.');
        process.exit(0);
      }

      DEBUG && console.error('Mirror', process.env.PORT, 'is working on', feature.name);
      _VelocityTestFiles.update(feature._id, {$set: {testable: false}});
      Meteor.wrapAsync(_runSingleFeature)(feature.absolutePath);
      feature = _getNextFeature();
    }
    timeToDie = true;

  }

  // TODO replace this with a more robust queue
  function _getNextFeature () {
    var features = _VelocityTestFiles.find({absolutePath: /\.feature$/, testable: true}).fetch();
    if (features.length === 0) {
      DEBUG && console.log('Mirror', process.env.PORT, 'has no more features to work on.');
      return null;
    }
    // randomize feature pickup order so mirrors don't take the same jobs
    var nextFeature = features[Math.floor(Math.random() * features.length)];
    return nextFeature;
  }

  function _runSingleFeature (featurePath, done) {

    var cucumber = Npm.require('cucumber');

    var execOptions = _getExecOptions(featurePath);
    var configuration = cucumber.Cli.Configuration(execOptions),
        runtime = cucumber.Runtime(configuration);

    var formatter = new cucumber.Listener.JsonFormatter();
    formatter.log = _.once(Meteor.bindEnvironment(function (results) {
      var features = JSON.parse(results);
      _processFeatures(features);
    }));

    _patchHelpers(cucumber, execOptions, configuration);

    runtime.attachListener(formatter);

    runtime.start(Meteor.bindEnvironment(done));
  }

  function _patchHelpers (cuke, execOptions, configuration) {
    // taken from https://github.com/xdissent/meteor-cucumber/blob/master/src/runner/local.coffee
    var argumentParser = cuke.Cli.ArgumentParser(execOptions);
    argumentParser.parse();
    configuration.getSupportCodeLibrary = function () {
      var supportCodeFilePaths, supportCodeLoader;
      supportCodeFilePaths = argumentParser.getSupportCodeFilePaths();
      supportCodeLoader = cuke.Cli.SupportCodeLoader(supportCodeFilePaths);
      supportCodeLoader._buildSupportCodeInitializerFromPaths = supportCodeLoader.buildSupportCodeInitializerFromPaths;
      supportCodeLoader.buildSupportCodeInitializerFromPaths = function (paths) {
        var wrapper = supportCodeLoader._buildSupportCodeInitializerFromPaths(paths);
        return function () {
          _patchHelper(this);
          return wrapper.call(this);
        };
      };
      return supportCodeLoader.getSupportCodeLibrary();
    };
  }

  function _patchHelper (helper) {

    if (helper._patched != null) {
      return;
    }
    helper._patched = true;

    var steps = [
      'World',
      'Around', 'Before', 'After',
      'defineStep',
      'BeforeStep', 'AfterStep',
      'BeforeScenario', 'AfterScenario',
      'BeforeFeature', 'AfterFeature',
      'BeforeFeatures', 'AfterFeatures'];
    _.each(steps, function (step) {
      DEBUG && console.log('[xolvio:cucumber] Patching', step);
      helper['_' + step] = helper[step];
      helper[step] = function () {
        var args = Array.prototype.splice.call(arguments, 0);
        var callback = args.pop();
        args.push(Meteor.bindEnvironment(callback));
        helper['_' + step].apply(helper, args);
      }
    });
    // Given, When, Then
    helper.Given = helper.When = helper.Then = helper.defineStep;

    // What about these?
    // registerListener
    // registerHandler
    // StepResult
    // Background

  }

  function _processFeatures (features) {
    _.each(features, function (feature) {
      _processFeature(feature);
    });
  }

  function _processFeature (feature) {
    _.each(feature.elements, function (element) {
      _processFeatureElements(element, feature);
    });
  }

  function _processFeatureElements (element, feature) {
    _.each(element.steps, function (step) {
      _processStep(element, step, feature);
    });
  }

  function _processStep (element, step, feature) {

    // Before elements are converted to steps within scenarios, so no need to process them here
    if (element.type === 'background') {
      return;
    }

    var report = {
      id: element.id + step.keyword + step.name,
      framework: FRAMEWORK_NAME,
      name: step.keyword + step.name,
      result: step.result.status,
      ancestors: [element.name, feature.name]
    };
    if (step.result.duration) {
      report.duration = Math.round(step.result.duration / 1000000);
    }
    if (step.result.error_message) {
      if (step.result.error_message.name) {
        report.failureType = step.result.error_message.name;
        // TODO extract message
        //report.failureMessage = step.result.error_message.message;
        // TODO extract problem
        // TODO extract callstack
        report.failureStackTrace = step.result.error_message.message;
      } else {
        report.failureStackTrace = step.result.error_message;
      }
    }

    // skip before/after if they have no errors
    if (!report.failureStackTrace && (step.keyword.trim() === 'Before' || step.keyword.trim() === 'After')) {
      return;
    }

    _velocity.call('velocity/reports/submit', report, function () {
      if (timeToDie) {
        process.exit(0);
      }

    });
    // Unused fields:
    // browser
    // timestamp
  }

  function _getExecOptions (featurePath) {

    // TODO externalize these options
    var options = {
      files: [featurePath],
      tags: [],
      format: 'progress' // 'summary' 'json' 'pretty' 'progress'
    };

    var execOptions = ['node', 'node_modules/.bin/cucumber-js'];

    if (!_.isEmpty(options.files)) {
      execOptions = execOptions.concat(options.files);
    }

    if (!_.isEmpty(options.steps)) {
      execOptions.push('--require');
      execOptions.push(options.steps);
    }

    if (!_.isEmpty(options.tags)) {
      execOptions.push('--tags');
      execOptions.push(options.tags);
    }

    if (!_.isEmpty(options.format)) {
      execOptions.push('--format');
      execOptions.push(options.format);
    }
    return execOptions;
  }

})();
