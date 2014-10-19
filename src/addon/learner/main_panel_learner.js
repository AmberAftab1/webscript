/* -*- Mode: Java; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set shiftwidth=2 tabstop=2 autoindent cindent expandtab: */

'use strict';

// find maximum number of deltas that can be applied
var SimpleDebug = (function SimpleDebugClosure() {
  var log = getLog('simpledebug');

  function SimpleDebug(orig, deltas, grouped, accumulate, test, callback) {
    this.orig = orig;
    this.deltas = deltas;
    this.grouped = grouped;
    this.accumulate = accumulate;
    this.test = test;
    this.callback = callback;
  }

  SimpleDebug.prototype = {
    run: function _run() {
      this.enabled = [];
      this.disabled = [];

      if (this.grouped) {
        this.index = [0, 0];
      } else {
        this.index = 0;
      }

      this.runTest();
    },
    runTest: function _runTest() {
      if (this.isFinished()) {
        log.debug('Finished minimizing:', this.enabled, this.disabled);
        var finished = jQuery.extend(true, [], this.orig);
        var enabled = this.enabled;
        for (var i = 0, ii = enabled.length; i < ii; ++i) {
          finished = enabled[i].delta.apply(finished);
        }
        this.finished = finished;
        if (this.callback)
          this.callback(this);
        return;
      }

      var cur = jQuery.extend(true, [], this.orig);
      var delta = this.getNextDelta();
      cur = delta.apply(cur);

      var enabled = this.enabled;
      if (this.accumulate) {
        for (var i = 0, ii = enabled.length; i < ii; ++i) {
          cur = enabled[i].delta.apply(cur);
        }
      }

      var test = this.test;
      var simpleDebug = this;

      test(cur, enabled, delta, function(result, data) {
        var info = {delta: delta, misc: data};
        if (!result) {
          simpleDebug.disabled.push(info);
        } else {
          simpleDebug.enabled.push(info);
        }
        simpleDebug.incrementIndex(result);
        setTimeout(function() {
          simpleDebug.runTest();
        }, 0);
      });
    },
    incrementIndex: function _incrementIndex(curDeltaSuccess) {
      if (this.grouped) {
        var index = this.index;
        var idxGroup = index[0];
        var idxDelta = index[1];

        var deltas = this.deltas;
        var deltaGroup = deltas[idxGroup];

        if (!curDeltaSuccess && idxDelta + 1 < deltaGroup.length) {
          index[1]++;
        } else {
          index[0]++;
          index[1] = 0;
        }
      } else {
        this.index++;
      }
    },
    getNextDelta: function _getNextDelta() {
      var deltas = this.deltas;
      var index = this.index;

      if (this.grouped) {
        return deltas[index[0]][index[1]];
      } else {
        return deltas[index];
      }
    },
    isFinished: function _isFinished() {
      var deltas = this.deltas;
      var index = this.index;
      var grouped = this.grouped;

      if (grouped) {
        return grouped && index[0] >= deltas.length;
      } else {
       return !grouped && index >= deltas.length;
      }
    }
  };

  return SimpleDebug;
})();

function runScript(id, events, numRuns, timeout, callback) {
  log.debug('Running script:', id, events, numRuns, timeout);
  var runs = [];
  function runOnce() {
    if (runs.length < numRuns) {
      var r = controller.replayScript(events, {}, function(replay) {
        clearTimeout(timeoutId);

        // remove any tabs related with the replay, so that web requests don't
        // from these tabs don't show up in future replays
        var events = replay.record.events;
        var allTabs = [];
        for (var i = 0, ii = events.length; i < ii; ++i) {
          var e = events[i];
          var tab = "";
          if (e.frame && e.frame.tab)
            tab = e.frame.tab;
          if (e.data && e.data.tabId)
            tab = e.data.tabId;

          if (tab && allTabs.indexOf(tab) < 0)
            allTabs.push(tab);
        }

        for (var i = 0, ii = allTabs.length; i < ii; ++i) {
          chrome.tabs.remove(parseInt(allTabs[i]));
        }

        var run = {
          index: replay.index,
          events: $.extend([], events),
          captures: $.extend([], replay.captures)
        };
        runs.push(run);

        setTimeout(function() {runOnce();});
      });

      // kill script after timeout period
      var timeoutId = setTimeout(function() {
        r.finish();
      }, timeout);
    } else {
      log.debug('Finished running script:', id, events, numRuns, timeout);
      callback(runs);
    }
  }
  runOnce();
}

function collectCaptures(events) {
  var expCaptures = [];
  for (var i = 0, ii = events.length; i < ii; ++i) {
    var e = events[i];
    if (e.type == 'capture') {
      expCaptures.push(e);
    }
  }
  return expCaptures;
}

function checkReplaySuccess(origEvents, replay) {
  var captureEvents = collectCaptures(origEvents); 
  log.debug('Check replay success:', captureEvents, origEvents, replay);

  var captures = replay.captures;
  for (var i = 0, ii = captureEvents.length; i < ii; ++i) {
    if (i >= captures.length) {
      return false;
    }

    var c = captures[i];
    var e = captureEvents[i];

    var eText = e.target.snapshot.prop.innerText;
    var cText = c.innerText;
    if (eText != cText) {
      return false;
    }
  }
  return true;
}

function runSynthWait(scriptName) {
  // create a unique id for this suite of replays
  var uniqueId = scriptName + ':' + (new Date()).getTime();
  log.debug('Running synthesis on:', uniqueId);

  // update the params so things will go faster
  params = jQuery.extend(true, {}, defaultParams);
  params.replay.eventTimeout = 40;
  //params.replay.defaultUser = true;
  params.replay.timingStrategy = TimingStrategy.SLOWER;
  params.panel.enableEdit = false;
  controller.updateParams();

  scriptServer.getScript(scriptName, function(script) {
    var scriptId = script.id;
    var events =  script.events;

    scriptServer.saveScript(uniqueId, events, scriptId, 'original');
    runSynthWait_getPassingRuns(uniqueId, script);
  });
}

function runSynthWait_getPassingRuns(uniqueId, script) {
  // run baseline scripts
  // check if these scripts executed correctly
  var passingRuns = [];
  var reqPassingRuns = 2;
  var events = script.events;

  function getPassingRuns(callback) {
    if (passingRuns.length >= reqPassingRuns) {
      return callback();
    }
    runScript(null, events, 1, 300 * 1000, function(runs) {
      var run = runs[0];
      // check if run passed
      if (checkReplaySuccess(events, run))
        passingRuns.push(run);

      scriptServer.saveScript(uniqueId, run.events, script.id,
          'replay,find_trigger');
      getPassingRuns(callback);
    });
  }
  getPassingRuns(function() {
    runSynthWait_getTriggers(uniqueId, script, passingRuns);
  });
}

var learningTriggers = [];
function runSynthWait_getTriggers(uniqueId, script, passingRuns) {
  // given a script, modify script so that eventId fires immediately after
  // the previous event
  function clearWaits(events, eventId, triggerEventId) {
    var lastEventIndex = 0;
    var eventIndex = -1;

    for (var j = 0, jj = events.length; j < jj; ++j) {
      var e = events[j];
      if (e.meta.id == eventId) {
        eventIndex = j;
        break;
      } else if (e.type == 'dom' || e.type == 'capture') {
        lastEventIndex = j;
      }
    }

    for (var j = lastEventIndex + 1; j <= eventIndex; ++j)  
      events[j].timing.waitTime = 0;
    
    if (typeof triggerEventId == 'string')
      events[eventIndex].timing.waitEvent = triggerEventId;

    return events;
  }

  var events = script.events;
  // get trigger mapping
  var triggers = mapPossibleTriggerToEvent(events, passingRuns);
  learningTriggers = triggers;
  log.debug("All triggers:", triggers);

  var triggerChanges = [];
  for (var i = 0, ii = events.length; i < ii; ++i) {
    var e = events[i];
    var id = e.meta.id;
    if (id in triggers) {
      var eventTriggers = triggers[id];
      var triggerGroup = [];
      for (var j = 0, jj = eventTriggers.length; j < jj; ++j) {
        var triggerEvent = eventTriggers[j];
        if (triggerEvent != 'nowait') {
          (function() {
            var eventId = id;
            var triggerEventId = triggerEvent;
            triggerGroup.push({
              id: 'add_trigger_' + eventId + '_' + triggerEventId,
              apply: function(origEvents) {
                return clearWaits(origEvents, eventId, triggerEventId);
              }
            });
          })();
        } else {
          (function() {
            var eventId = id;
            triggerGroup.push({
              id: 'no_wait_' + eventId,
              apply: function(origEvents) {
                return clearWaits(origEvents, eventId);
              }
            });
          })();
        }
      }
      triggerChanges.push(triggerGroup);
    }
  }
  runSynthWait_main(uniqueId, script, triggerChanges);
}

// store all the replays
var learningReplays = [];
function runSynthWait_main(uniqueId, script, triggerChanges) {
  var events = script.events;
  var scriptId = script.id;

  learningReplays = [];

  // test whether the modified script still passes
  function testScript(modifiedEvents, enabled, delta, callback) {
    // lets make it replay a bit harder
    // params.replay.defaultWaitNewTab = 100;
    // params.replay.targetTimeout = 1;
    // controller.updateParams();

    scriptServer.saveScript(uniqueId, modifiedEvents, scriptId,
        'original,' + delta.id);

    runScript(null, modifiedEvents, 2, 300 * 1000,
        function(replays) {
          var passed = true;

          for (var i = 0, ii = replays.length; i < ii; ++i) {
            var r = replays[i];
            learningReplays.push(r);
            var pass = checkReplaySuccess(events, r);

            scriptServer.saveScript(uniqueId, r.events, scriptId,
                'replay,' + delta.id + ',' + pass);
            passed = passed && pass;
          }
          callback(passed);
        });
  }

  log.debug('Trying to synthesize waits');
  var debug = new SimpleDebug(events, triggerChanges, true, true, testScript,
      function(debug) {
        log.debug(debug);
        scriptServer.saveScript(uniqueId, debug.finished, scriptId, 'final');
        saveReplayInfo();
        learnFromReplays(uniqueId, script);
      });
  debug.run();
}

function saveReplayInfo() {
  chrome.storage.local.set({
    learningReplays: learningReplays,
    learningTriggers: learningTriggers
  })
}

function loadReplayInfo() {
  chrome.storage.local.get(["learningReplays", "learningTriggers"], 
      function(info) {
        learningReplays = info.learningReplays;
        learningTriggers = info.learningTriggers;
      }
  );
}

function learnFromReplays(uniqueId, script) {
  var replays = learningReplays;
  var triggers = learningTriggers;
  var filteredTriggers = {};
  for (e in triggers) {
    var t = triggers[e].filter(function(v) {
        return v != 'nowait';
    });
    if (t.length != 0)
      filteredTriggers[e] = t;
  }
  triggers = filteredTriggers
}

function getCompletedUrls(replay) {
  var events = replay.events;
  var completed = events.filter(function(e) {return e.type == 'completed'});
  return completed.map(function(e) {return e.data.url});
}

function getPossibleTriggerUrls(replays) {
  var urlLists = replays.map(getCompletedUrls);
  var intersectList = urlLists[0];
  for (var i = 1, ii = urlLists.length; i < ii; ++i) {
    var l = urlLists[i];
    intersectList = intersectList.filter(function(url) {
      return l.indexOf(url) != -1;
    });
  }
  return intersectList;
}

function mapPossibleTriggerToEvent(orig, replays) {
  var triggerUrls = getPossibleTriggerUrls(replays);

  var mapping = {};
  var completedEvents = [];
  completedEvents.push('nowait');

  for (var i = 0, ii = orig.length; i < ii; ++i) {
    var e = orig[i];
    if (e.type == 'dom' || e.type == 'capture') {
      mapping[e.meta.id] = completedEvents;
      completedEvents = [];
      completedEvents.push('nowait');
    } else if (e.type == 'completed') {
      if (triggerUrls.indexOf(e.data.url) != -1) {
        completedEvents.push(e.meta.id);
      }
    }
  }
  return mapping;
}

