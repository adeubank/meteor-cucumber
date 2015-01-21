cucumber = {};

DEBUG = !!process.env.VELOCITY_DEBUG;

(function () {

  'use strict';

  //if (process.env.NODE_ENV !== 'development' || process.env.CUCUMBER == '0' ||
  //  process.env.VELOCITY == '0') {
  //  return;
  //}

  console.log('* * * * * * [xolvio:cucumber] Cucumber is loading in', process.env.IS_MIRROR ? 'MIRROR' : 'MAIN');

  var path = Npm.require('path'),
      fs = Npm.require('fs'),
      FRAMEWORK_NAME = 'cucumber',
      FRAMEWORK_REGEX = FRAMEWORK_NAME + '/.+\\.(feature|js|coffee|litcoffee|coffee\\.md)$',
      featuresRelativePath = path.join(FRAMEWORK_NAME, 'features'),
      featuresPath = path.join(_getTestsPath(), featuresRelativePath),
      _velocity;

  if (Velocity && Velocity.registerTestingFramework) {
    Velocity.registerTestingFramework(FRAMEWORK_NAME, {
      regex: FRAMEWORK_REGEX,
      sampleTestGenerator: _getSampleTestFiles
    });
  }

  // Bail if there aren't any features defined yet
  if (!fs.existsSync(featuresPath)) {
    return;
  }

  // if on the master, just request the mirror workers
  if (!process.env.IS_MIRROR) {
    //// TODO make the number of mirrors configurable
    //Meteor.startup(function () {
    //  Meteor.call('velocity/mirrors/request', {
    //    framework: 'cucumber'
    //  });
    //});
    return;
  }

  // when on the mirror, connect to the parent velocity and subscribe
  if (process.env.IS_MIRROR) {
    _velocity = DDP.connect(process.env.PARENT_URL);
    _velocity.onReconnect = function () {
      //var debouncedRerunCucumber = _.debounce(Meteor.bindEnvironment(_rerunCucumber), 300);
      var debouncedRerunCucumber = function () {
        console.log('observed');
      };

      console.log('- - - - - - - VelocityTestFiles');
      console.log(VelocityTestFiles);


      _velocity.subscribe('VelocityTestFiles', {
        onReady: function () {
          console.log('- - - - - - - VelocityTestFiles subscribe callback');
          console.log(VelocityTestFiles.find().fetch());
        },
        onError: function () {
          console.log('error', arguments)
        }
      });

      Meteor.setTimeout(function() {
        console.log('- - - - - - - after 4 secs');
        console.log(VelocityTestFiles.find().fetch());
      }, 4000);

      _velocity.call('velocity/isMirror', function () {
        console.log('isMirror call', arguments);
      });


      VelocityTestFiles.find({targetFramework: FRAMEWORK_NAME}).observe({
        added: debouncedRerunCucumber,
        removed: debouncedRerunCucumber,
        changed: debouncedRerunCucumber
      });
    };
  }


  var Module = Npm.require('module');

  function _rerunCucumber (file) {

    console.log('[xolvio:cucumber] Cucumber is running');

    delete Module._cache[file.absolutePath];

    var cuke = Npm.require('cucumber');

    var execOptions = _getExecOptions();
    var configuration = cuke.Cli.Configuration(execOptions),
        runtime = cuke.Runtime(configuration);

    var formatter = new cuke.Listener.JsonFormatter();
    formatter.log = _.once(Meteor.bindEnvironment(function (results) {

      _velocity.call('velocity/reports/reset', {framework: FRAMEWORK_NAME}, function () {
        var features = JSON.parse(results);
        _processFeatures(features);
      });
    }));

    _patchHelpers(cuke, execOptions, configuration);

    runtime.attachListener(formatter);
    runtime.attachListener(configuration.getFormatter());

    runtime.start(Meteor.bindEnvironment(function runtimeFinished () {
      _velocity.call('velocity/reports/completed', {framework: FRAMEWORK_NAME}, function () {
        DEBUG && console.log('[xolvio:cucumber] Completed');
      });
    }));
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

    _velocity.call('velocity/reports/submit', report);
    // Unused fields:
    // browser
    // timestamp
  }

  function _getExecOptions () {

    // TODO externalize these options
    var options = {
      files: [featuresPath],
      //steps: path.join(featuresPath, 'step_definitions'),
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


})();
