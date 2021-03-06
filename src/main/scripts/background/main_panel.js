/* -*- Mode: Java; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set shiftwidth=2 tabstop=2 autoindent cindent expandtab: */

'use strict';

/* Store mappings between ports, tabs, iframes, etc */
var PortManager = (function PortManagerClosure() {
  var portLog = getLog('ports');

  function PortManager() {
    this.numPorts = 0;
    this.portIdToPort = {};
    this.portIdToTabId = {};
    this.portIdToPortInfo = {};
    this.tabIdToPortIds = {};
    this.tabIdToTabInfo = {};
    this.tabIdToTab = {};
  }

  PortManager.prototype = {
    /* Send a message to all content scripts. Messages should be in the form
     * {type: ..., value: ...} */
    sendToAll: function _sendToAll(message) {
      portLog.log('Sending to all:', message);
      var ports = this.portIdToPort;
      for (var portId in ports) {
        ports[portId].postMessage(message);
      }
    },
    getTabId: function _getTabId(portId) {
      return this.portIdToTabId[portId];
    },
    getTabInfo: function _getTabInfo(tabId) {
      var tabInfo = this.tabIdToTabInfo[tabId];
      if (!tabInfo)
        return null;

      var ret = {};
      ret.frames = tabInfo.frames;

      /* we store all the top frames, so just return the last frame */
      var topFrames = tabInfo.top;
      if (topFrames.length > 0)
        ret.top = topFrames[topFrames.length - 1];

      return ret;
    },
    getTabFromTabId: function _getTabFromTabId(tabId) {
      return this.tabIdToTab[tabId];
    },
    getPort: function _getPort(portId) {
      return this.portIdToPort[portId];
    },
    updateUrl: function _updateUrl(port, url) {
      this.portIdToPortInfo[port.name].URL = url;
    },
    removeTab: function _removeTab(tabId) {
      delete this.tabIdToPortIds[tabId];
      delete this.tabIdToTab[tabId];
      delete this.tabIdToTabInfo[tabId];
    },
    updateRemovedTabs: function _updateRemovedTabs(openTabs) {
      var possiblyOpenTabs = {};
      for (var tabId in this.tabIdToTab) {
        possiblyOpenTabs[tabId] = false;
      }

      for (var i = 0, ii = openTabs.length; i < ii; ++i) {
        possiblyOpenTabs[openTabs[i].id] = true;
      }

      for (var tabId in possiblyOpenTabs)
        if (!possiblyOpenTabs[tabId])
          this.removeTab(tabId);
    },
    getNewId: function _getNewId(value, sender) {
      /* for some reason, the start page loads the content script but doesn't
       * have a tab id. in this case, don't assign an id */
      if (!sender.tab) {
        portLog.warn('Request for new id without a tab id');
        return;
      }

      /* bug with listening to removed tabs, so lets actually check which
       * tabs are open and then update our list appropriately */
      var ports = this;
      chrome.tabs.query({}, function(openTabs) {
        ports.updateRemovedTabs(openTabs);
      });

      this.numPorts++;
      var portId = '' + this.numPorts;

      portLog.log('Adding new id: ', portId, value);

      /* Update various mappings */
      var tabId = sender.tab.id;
      this.tabIdToTab[tabId] = sender.tab;
      portLog.log('Adding tab:', tabId, sender.tab);

      this.portIdToTabId[portId] = tabId;
      this.portIdToPortInfo[portId] = value;
      value.portId = portId;

      var portIds = this.tabIdToPortIds[tabId];
      if (!portIds) {
        portIds = [];
        this.tabIdToPortIds[tabId] = portIds;
      }
      portIds.push(portId);

      var tabInfo = this.tabIdToTabInfo[tabId];
      if (!tabInfo) {
        tabInfo = {top: [], frames: []};
        this.tabIdToTabInfo[tabId] = tabInfo;
      }
      if (value.top) {
        tabInfo.top.push(value);
      } else {
        tabInfo.frames.push(value);
      }
      return portId;
    },
    connectPort: function _connectPort(port) {
      var portId = port.name;
      var ports = this.portIdToPort;

      ports[portId] = port;

      port.addMessageListener(function(msg) {
        handleMessage(port, msg);
      });

      var portManager = this;
      port.addDisconnectListener(function(evt) {
        portLog.log('Disconnect port:', port);

        if (portId in ports) {
          delete ports[portId];
        } else {
          throw "Can't find port";
        }

        var portInfo = portManager.portIdToPortInfo[portId];
        var tabId = portManager.portIdToTabId[portId];
        var tabInfo = portManager.tabIdToTabInfo[tabId];

        var frames;
        if (tabInfo) {
          if (portInfo.top)
            var frames = tabInfo.top;
          else
            var frames = tabInfo.frames;

          for (var i = 0, ii = frames.length; i < ii; ++i) {
            if (frames[i].portId == portId) {
              frames.splice(i, 1);
              break;
            }
          }
        } else {
          portLog.error('Cannot find information about tab:', tabId, tabInfo);
        }
      });
    }
  };

  return PortManager;
})();

/* Handles recording of events from the content scripts */
var Record = (function RecordClosure() {
  var recordLog = getLog('record');

  function Record(ports) {
    this.ports = ports;
    this.listeners = [];

    this.reset();
  }

  Record.prototype = {
    reset: function _reset() {
      this.updateStatus(RecordState.STOPPED);
      this.scriptId = null;
      this.events = [];
      /* the time the last event was recorded */
      this.lastTime = 0;

      this.updateListeners({type: 'reset', value: null});
      this.ports.sendToAll({type: 'reset', value: null});
    },
    /* Messages should be in the form {type:..., value:...} */
    addListener: function _addListener(callback) {
      this.listeners.push(callback);
    },
    updateListeners: function _updateListeners(msg) {
      var listeners = this.listeners;
      for (var i = 0, ii = listeners.length; i < ii; ++i) {
        listeners[i](msg);
      }
    },
    getStatus: function _getStatus() {
      return this.recordState;
    },
    updateStatus: function _updateStatus(newStatus) {
      this.recordState = newStatus;
      this.updateListeners({type: 'status', value: 'record:' + newStatus});
      this.ports.sendToAll({type: 'recording', value: newStatus});
    },
    /* Begin recording events.
     *
     * @param {boolean} replaying Whether we are recording a user's
     *     interactions or the events raised by the replayer. 
     */
    startRecording: function _startRecording(replaying) {
      recordLog.log('Starting record');
      var s = replaying ? RecordState.REPLAYING : RecordState.RECORDING;
      this.updateStatus(s);

      /* Tell the content scripts to begin recording */
      this.ports.sendToAll({type: 'recording', value: this.getStatus()});
    },
    stopRecording: function _stopRecording() {
      recordLog.log('Stopping record');
      this.updateStatus(RecordState.STOPPED);

      /* Tell the content scripts to stop recording */
      this.ports.sendToAll({type: 'stop', value: null});
      this.ports.sendToAll({type: 'recording', value: this.getStatus()});
    },
    /* Add the event to be recorded
     *
     * @param {object} eventRequest Details of about the saved event
     * @param {string} portId Optional name of the port for the event
     * @param {index} index Index where put the event. Defaults to the end of
     *     the event array if undefined
     *
     * @returns {string} Id assigned to the event
     */
    addEvent: function _addEvent(e, portId, index) {
      recordLog.log('Added event:', e, portId);

      /* Check if the event is coming from a content script */
      if (portId) {
        var ports = this.ports;
        var tab = ports.getTabId(portId);
        var tabInfo = ports.getTabInfo(tab);
        // TODO: this is broken, maybe
        var topURL = tabInfo.top.URL;

        var iframeIndex = -1;
        var topFrame = (tabInfo.top.portId == portId);

        if (topFrame) {
          var topFrame = true;
        } else {
          var topFrame = false;
          var frames = tabInfo.frames;
          for (var i = 0, ii = frames.length; i < ii; ++i) {
            var frame = frames[i];
            if (frame.portId == portId) {
              iframeIndex = i;
              break;
            }
          }
        }

        e.frame.port = portId;
        e.frame.topURL = topURL;
        e.frame.topFrame = topFrame;
        e.frame.iframeIndex = iframeIndex;
        e.frame.tab = tab;
      }

      /* Save timing info */
      var time = e.data.timeStamp;
      var lastTime = this.lastTime;
      if (lastTime == 0) {
        var waitTime = 0;
      } else {
        var waitTime = time - lastTime;
      }
      if (!('timing' in e))
        e.timing = {};
      e.timing.waitTime = waitTime;
      this.lastTime = time;

      /* Give this event an unique id */
      var events = this.events;
      if (!('meta' in e))
        e.meta = {};
      e.meta.id = 'event' + events.length;

      if (typeof index == 'undefined') {
        this.events.push(e);
        this.updateListeners({type: 'event', value: {event: e}});
      } else {
        this.events.splice(index, 0, e);
        this.updateListeners({type: 'event', 
            value: {event: e, index: index}});
      }
      return e.meta.id;
    },
    /* Update the properties of an event. @link{eventRequest} should contain the
     * pageEventId so that the event can be matched.
     *
     * @param {object} eventRequest Updates to be made and meta data used to 
     *     identify event
     * @param {string} portId Id of port which requests came through
     */
    updateEvent: function _updateEvent(request, portId) {
      var pageEventId = request.pageEventId;
      var updates = request.updates;

      recordLog.log('Updating event:', updates, pageEventId);

      var events = this.events;

      for (var i = events.length - 1; i >= 0; --i) {
        var value = events[i];
        /* Check if its the right event */
        if (value.frame && value.frame.port == portId &&
            value.meta && value.meta.pageEventId == pageEventId) {
          var id = value.meta.id;
          for (var i = 0, ii = updates.length; i < ii; ++i) {
            var u = updates[i];
            this.userUpdate(id, u.field, u.value); 
          }
          break;
        }
      }
    },
    /* Finds the event based upon the eventId and updates the event's 
     * @link{field} to @link{newVal}. */
    userUpdate: function _userUpdate(eventId, field, newVal) {
      function updateProp(obj, path, i) {
        if (i == path.length - 1)
          obj[path[i]] = newVal;
        else
          updateProp(obj[path[i]], path, i + 1);
      }

      var events = this.events;
      for (var i = events.length - 1; i >= 0; --i) {
        var value = events[i];
        if (value.meta.id == eventId) {
          updateProp(value, field.split('.'), 0);
        }
      }
    },
    /* Create a copy of the events recorded */
    getEvents: function _getEvents() {
      return jQuery.extend(true, [], this.events);
    },
    /* Set the recorded events */
    setEvents: function _setEvents(events) {
      this.reset();
      this.events = events;
      for (var i = 0, ii = events.length; i < ii; ++i) {
        this.updateListeners({type: 'event', value: {event: events[i]}});
      }
    },
    setScriptId: function _setScriptId(id) {
      this.scriptId = id;
    },
    getScriptId: function _getScriptId() {
      return this.scriptId;
    },
    getEvent: function _getEvent(eventId) {
      var events = this.events;
      if (!events)
        return null;

      for (var i = 0, ii = events.length; i < ii; ++i) {
        var e = events[i];
        if (e.meta.id == eventId)
          return e;
      }
      return null;
    }
  };

  return Record;
})();

/* Handles replaying scripts */
var Replay = (function ReplayClosure() {
  var replayLog = getLog('replay');

  function Replay(ports, scriptServer, user) {
    this.ports = ports;
    this.scriptServer = scriptServer;
    /* The user interface to interact with the replayer */
    this.user = user;
    this.record = new Record(ports);
    this.listeners = [];

    this.reset();
  }

  /* Used to validate the user's response */
  function yesNoCheck(response) {
    if (response == 'yes' || response == 'y')
      return 'yes';
    else if (response == 'no' || response == 'n')
      return 'no';

    return null;
  }

  Replay.prototype = {
    replayableEvents: {
      dom: 'simulateDomEvent',
    },
    addonReset: [],
    addonTiming: [],
    reset: function _reset() {
      /* execution proceeds as callbacks so that the page's JS can execute, this
       * is the handle to the current callback */
      this.callbackHandle = null;
      this.replayState = this.updateStatus(ReplayState.STOPPED);
      /* record the first execution attempt of the first event */
      this.timeoutInfo = {startTime: 0, index: -1};
      this.triggerTimeoutInfo = {startTime: 0, index: -1};
      /* stores responses from the content script */
      this.ack = null;
      /* list of events */
      this.events = [];
      /* current event index */
      this.index = 0;
      /* maps between the record and replay time ports and tabs */
      this.portMapping = {};
      this.tabMapping = {};
      this.lastTab = null;
      /* used to link the replayed events with the original recording */
      this.scriptId = null;
      /* callback executed after replay has finished */
      this.cont = null;
      this.firstEventReplayed = false;
      this.startTime = 0;
      this.triggerTimeouts = 0;
      this.elementTimeouts = 0;

      /* Call the resets for the addons */
      var addonReset = this.addonReset;
      for (var i = 0, ii = addonReset.length; i < ii; ++i)
        addonReset[i].call(this);

      this.record.reset();
    },
    /* Messages should be in the form {type:..., value:...} */
    addListener: function _addListener(callback) {
      this.listeners.push(callback);
    },
    updateListeners: function _updateListeners(msg) {
      var listeners = this.listeners;
      for (var i = 0, ii = listeners.length; i < ii; ++i) {
        listeners[i](msg);
      }
    },
    updateStatus: function _updateStatus(newStatus) {
      this.replayState = newStatus;
      this.updateListeners({type: 'status', value: 'replay:' + newStatus});
    },
    /* Begin replaying a list of events.
     *
     * @param {array} events List of events
     * @param {string} scriptId Id of the original recording
     * @param {function} cont Callback thats executed after replay is finished
     */
    replay: function _replay(events, config, cont) {
      replayLog.log('Starting replay');

      /* Pause and reset and previous executions */
      this.pause();
      this.reset();

      /* Record start time for debugging */
      this.startTime = new Date().getTime();
      /* If these events were already replayed, we may need to reset them */
      this.events = events;
      for (var i = 0, ii = events.length; i < ii; ++i)
        this.resetEvent(events[i]);

      if (config) {
        if (config.scriptId)
          this.scriptId = config.scriptId;
        
        if (config.frameMapping) {
          var frameMapping = config.frameMapping;
          var portMapping = this.portMapping;
          var ports = this.ports;
          for (var k in frameMapping)
            portMapping[k] = ports.getPort(frameMapping[k]);
        }
      }

      this.cont = cont;
      this.updateStatus(ReplayState.REPLAYING);

      this.record.startRecording(true);
      this.setNextTimeout(0);
    },
    /* Replay a different set of events as a subexecution. This requires 
     * saving the context of the current execution and resetting it once
     * the execution is finished.
     *
     * @param {array} events List of events to replay
     * @param {string} scriptId Id of script
     * @param {object} tabMapping Initial tab mapping
     * @param {object} portMapping Initial port mapping
     * @param {function} check Callback after subreplay is finished. The replay
     *     is passed in as an argument.
     * @param {function} cont Callback after subreplay is finished and 
     *     replayer's state is reset to original.
     * @param {number} timeout Optional argument specifying a timeout for the
     *     subreplay.
     */
    subReplay: function _subReplay(events, scriptId, tabMapping, portMapping,
                                   check, cont, timeout) {
      /* copy the properties of the replayer (so they can be later reset) */
      var props = Object.keys(this);
      var copy = {};
      for (var i = 0, ii = props.length; i < ii; ++i) {
        var prop = props[i];
        copy[prop] = this[prop];
      }

      /* replay the events */
      var replay = this;
      this.replay(events, {scriptId: scriptId}, function(r) {
        if (timeout) {
          clearTimeout(timeoutId);
        }
        check(r);

        this.reset();
        for (var key in copy) {
          replay[key] = copy[key];
        }

        this.updateStatus(ReplayState.REPLAYING);
        this.record.startRecording(true);

        cont(r);
      });

      /* set the mappings */
      this.tabMapping = tabMapping;
      this.portMapping = portMapping;

      if (timeout) {
        var timeoutId = setTimeout(function() {
          replay.finish();
        }, timeout);
      }
    },
    /* Get an event object based upon its id */
    getEvent: function _getEvent(eventId) {
      var events = this.events;
      if (!events)
        return null;

      for (var i = 0, ii = events.length; i < ii; ++i) {
        var e = events[i];
        if (e.meta.id == eventId)
          return e;
      }
      return null;
    },
    getStatus: function _getStatus() {
      return this.replayState;
    },
    /* Increase the index and update the listeners */
    incrementIndex: function _incrementIndex() {
      this.index += 1;

      var index = this.index;
      var events = this.events;
      if (index < events.length) {
        var e = events[index];
        if (e.meta)
          this.updateListeners({type: 'simulate', value: e.meta.id});
      }
    },
    /* Return the index of the next event that should be replayed */ 
    getNextReplayableEventIndex: function _getNextReplayableEventIndex() {
      var index = this.index;
      var events = this.events;
      var replayableEvents = this.replayableEvents;

      for (var i = index, ii = events.length; i < ii; ++i) {
        var v = events[i].type;
        if (events[i].type in replayableEvents)
          return i;
      }
      return events.length;
    },
    /* Return the time in the future the next replayable event should be
     * executed based upon the current timing strategy. */
    getNextTime: function _getNextTime() {
      var time;
      /*  */
      var addonTiming = this.addonTiming;
      for (var i = 0, ii = addonTiming.length; i < ii; ++i) {
        time = addonTiming[i].call(this);
        if (typeof time == 'number')
          return time;
      }

      var timing = params.replay.timingStrategy;

      var curIndex = this.index;
      var nextIndex = this.getNextReplayableEventIndex();
      var events = this.events;
      var waitTime = 0;

      /* Check if there are any events to replay */
      if (nextIndex >= events.length)
        return 0;
      if (curIndex == 0)
        return 1000;

      var defaultTime = 0;
      for (var i = curIndex; i <= nextIndex; ++i)
        defaultTime += events[i].timing.waitTime;

      if (defaultTime > 10000)
        defaultTime = 10000;

      if (timing == TimingStrategy.MIMIC) {
        waitTime = defaultTime;
      } else if (timing == TimingStrategy.SPEED) {
        waitTime = 0;
      } else if (timing == TimingStrategy.SLOWER) {
        waitTime = defaultTime * 2;
      } else if (timing == TimingStrategy.SLOWEST) {
        waitTime = defaultTime * 4;
      } else if (timing == TimingStrategy.FIXED_1) {
        waitTime = 1000;
      } else if (timing == TimingStrategy.RANDOM_0_3) {
        waitTime = Math.round(Math.random() * 3000);
      } else if (timing == TimingStrategy.PERTURB_0_3) {
        waitTime = defaultTime + Math.round(Math.random() * 3000);
      } else if (timing == TimingStrategy.PERTURB) {
        var scale = 0.7 + (Math.random() * 0.6);
        waitTime = Math.round(defaultTime * scale);
      } else {
        throw 'unknown timing strategy';
      }
      replayLog.log('Wait time:', waitTime);
      return waitTime;
    },
    /* Set the callback to replay the next event
     *
     * @param {number} time Optional delay when callback should be executed. The
     *     default will use whatever strategy is set in the parameters.
    */
    setNextTimeout: function _setNextTimeout(time) {
      if (typeof time == 'undefined')
        time = this.getNextTime();

      replayLog.debug('Set timeout:', time);

      var replay = this;
      this.callbackHandle = setTimeout(function() {
        replay.guts();
      }, time + 10);
    },
    /* Pause the execution by clearing out the callback */
    pause: function _pause() {
      var handle = this.callbackHandle;
      if (handle) {
        clearTimeout(handle);
        this.callbackHandle = null;
      }

      /* tell whatever page was trying to execute the last event to pause */
      this.ports.sendToAll({type: 'pauseReplay', value: null});
    },
    /* Restart by setting the next callback immediately */
    restart: function _restart() {
      if (this.callbackHandle == null) {
        if (this.getStatus() == ReplayState.ACK) {
          this.updateStatus(ReplayState.REPLAYING);
        }

        this.setNextTimeout(0);
      }
    },
    replayOne: function _replayOne() {
//      this.updateStatus(ReplayState.REPLAYING);
//      this.restart();
    },
    skip: function _skip() {
      this.incrementIndex();
      this.updateStatus(ReplayState.REPLAYING);
    },
    resend: function _resend() {
      if (this.getStatus() == ReplayState.ACK)
        this.updateStatus(ReplayState.REPLAYING);
    },
    /* Replay has finished, and now we need to call the continuation */
    finish: function _finish(errorMsg) {
      replayLog.log('Finishing replay');

      if (this.getStatus() == ReplayState.STOPPED)
        return;

      this.updateStatus(ReplayState.STOPPED);

      this.pause();
      this.time = new Date().getTime() - this.startTime;
      this.errorMsg = errorMsg;
      this.record.stopRecording();

      var record = this.record;
      var replay = this;

      /* save the recorded replay execution */
      var scriptServer = this.scriptServer;
      setTimeout(function() {
        var replayEvents = record.getEvents();
        var scriptId = replay.scriptId;
        var captures = replay.captures;
        var notes = "";
        if (errorMsg)
          notes += errorMsg;

        if (params.replay.saveReplay && scriptId &&
            replayEvents.length > 0) {
          scriptServer.saveScript('replay ' + scriptId, replayEvents,
              scriptId, params, captures, notes);
          replayLog.log('Saving replay:', replayEvents);
        }
      }, 1000);

      if (this.cont) {
        var replay = this;
        setTimeout(function() {
          replay.cont(replay);
        }, 0);
      }
    },
    /* Given an event, find the corresponding port */
    getMatchingPort: function _getMatchingPort(v) {
      var portMapping = this.portMapping;
      var tabMapping = this.tabMapping;

      var frame = v.frame;
      var port = frame.port;
      var tab = frame.tab;

      /* lets find the corresponding port */
      var replayPort = null;
      /* we have already seen this port, reuse existing mapping */
      if (port in portMapping) {
        replayPort = portMapping[port];
        replayLog.log('Port already seen', replayPort);

      /* we have already seen this tab, find equivalent port for tab
       * for now we will just choose the last port added from this tab */
      } else if (tab in tabMapping) {
        var replayPort = this.findPortInTab(tabMapping[tab], frame);

        if (replayPort) {
          portMapping[port] = replayPort;
          replayLog.log('Tab already seen, found port:', replayPort);
        } else {
          this.setNextTimeout(params.replay.defaultWait);
          replayLog.log('Tab already seen, no port found');
        }
      /* nothing matched, so we need to open new tab */
      } else {
        var allTabs = Object.keys(this.ports.tabIdToTab);

        /* create list of all current tabs that are mapped to */
        var revMapping = {};
        for (var t in tabMapping) {
          revMapping[tabMapping[t]] = true;
        }

        /* find all tabs that exist, but are not mapped to */
        var unusedTabs = [];
        for (var i = 0, ii = allTabs.length; i < ii; ++i) {
          var tabId = allTabs[i];
          if (!revMapping[tabId])
            unusedTabs.push(tabId);
        }

        /* if this is not the first event, and there is exactly one unmapped
         * tab, then lets assume this new tab should match */
        if (this.firstEventReplayed && unusedTabs.length == 1) {
          tabMapping[frame.tab] = unusedTabs[0];
          this.lastTab = unusedTabs[0];
          this.setNextTimeout(0);
          return;
        }

        /* create a new tab, and update the mapping */
        var replay = this;
        var openNewTab = function() {
          replayLog.log('Need to open new tab');
          chrome.tabs.create({url: frame.topURL, active: true},
            function(newTab) {
              replayLog.log('New tab opened:', newTab);
              var newTabId = newTab.id;
              replay.tabMapping[frame.tab] = newTabId;
              replay.lastTab = newTabId;
              replay.ports.tabIdToTab[newTabId] = newTab;
              replay.setNextTimeout(params.replay.defaultWaitNewTab);
            }
          );
        };

        /* automatically open up a new tab for the first event */
        if (!this.firstEventReplayed && params.replay.openNewTab) {
          openNewTab();
        /* ask the user if the page exists, or a new tab should be opened */
        } else {
          var prompt = 'Does the page exist? If so select the tab then type ' +
                       "'yes'. Else type 'no'.";
          var user = this.user;
          user.question(prompt, yesNoCheck, 'no', function(answer) {
            if (answer == 'no') {
              openNewTab();
            } else if (answer == 'yes') {
              var tabInfo = user.getActivatedTab();
              chrome.tabs.get(tabInfo.tabId, function(tab) {
                replayLog.log('Mapping tab:', tab);
                var tabId = tab.id;
                replay.tabMapping[frame.tab] = tabId;
                replay.lastTab = tabId;
                replay.setNextTimeout(0);
              });
            }
          });
        }
      }
      return replayPort;
    },
    /* Given the frame information from the recorded trace, find a 
     * corresponding port */ 
    findPortInTab: function _findPortInTab(newTabId, frame) {
      var ports = this.ports;
      var portInfo = ports.getTabInfo(newTabId);
      replayLog.log('Trying to find port in tab:', portInfo);

      if (!portInfo)
        return null;

      /* if its the top frame, then ensure the urls match */
      if (frame.topFrame) {
        replayLog.log('Assume port is top level page');
        var topFrame = portInfo.top;
        if (topFrame) {
          if (matchUrls(frame.URL, topFrame.URL))
            return ports.getPort(topFrame.portId);
        }
      /* if its an iframe, find all frames with matching urls */
      } else {
        replayLog.log('Try to find port in one of the iframes');
        var frames = portInfo.frames;
        var urlFrames = [];
        for (var i = 0, ii = frames.length; i < ii; i++) {
          if (frames[i].URL == frame.URL) {
            urlFrames.push(frames[i]);
          }
        }

        /* no matching frames */
        if (urlFrames.length == 0) {
          return null;
        } else if (urlFrames.length == 1) {
          return ports.getPort(urlFrames[0].portId);
        }

        replayLog.warn('Multiple iframes with same url:', urlFrames);
      }
      return null;
    },
    /* Check if an event has already been replayed */
    checkReplayed: function _checkReplayed(eventObj) {
      var id = eventObj.meta.id;
      var recordedEvents = this.record.events;
      for (var i = recordedEvents.length - 1; i >= 0; --i) {
        var recordedEvent = recordedEvents[i];
        if (recordedEvent.meta.recordId == id)
          return true;
      }
      return false;
    },
    /* Check if executing an event has timed out */
    checkTimeout: function _checkTimeout() {
      var eventTimeout = params.replay.eventTimeout;
      if (eventTimeout != null && eventTimeout > 0) {
        var timeoutInfo = this.timeoutInfo;
        var curTime = new Date().getTime();

        /* we havent changed events */
        var index = this.index;
        if (timeoutInfo.index == index) {
          if (curTime - timeoutInfo.startTime > eventTimeout * 1000) {
            return true;
          }
        } else {
          this.timeoutInfo = {startTime: curTime, index: index};
        }
      }
      return false;
    },
    /* The main function which dispatches events to the content script */
    guts: function _guts() {
      if (this.checkTimeout()) {
        /* lets call the end of this script */
        // var msg = 'Event ' + this.index + ' has timed out';
        // replayLog.warn(msg);
        // this.finish(msg);

        this.screenshot("timeout");

        /* lets just skip the event */
        this.incrementIndex();
        this.setNextTimeout();

        replayLog.warn('Event timeout');

        this.updateStatus(ReplayState.REPLAYING);
        this.elementTimeouts += 1;
        return;
      }

      if (this.getStatus() == ReplayState.ACK) {
        var ack = this.ack;
        if (!ack) {
          this.setNextTimeout(params.replay.defaultWait);
          replayLog.info('Continue waiting for replay ack');
          return;
        }

        type = ack.type;
        if (type == Ack.SUCCESS) {
          replayLog.log('Found replay ack');
          this.incrementIndex();
          this.setNextTimeout();

          this.updateStatus(ReplayState.REPLAYING);
        } else if (type == Ack.PARTIAL) {
          throw 'partially executed commands';
        }
        return;
      }

      var events = this.events;
      var index = this.index;

      /* check if the script finished */
      if (index >= events.length) {
        this.finish();
        return;
      }

      var e = events[index];
      var type = e.type;

      /* Find the replay function associated with the event type */
      var replayFunctionName = this.replayableEvents[type];
      var replayFunction = this[replayFunctionName];
      if (!replayFunction) {
        replayLog.info('Skipping event (no replay function):', type, e);
        this.incrementIndex();
        this.setNextTimeout(0);
        return;
      }
      replayLog.debug('Replaying event:', type, e);

      replayFunction.call(this, e);
    },
    /* Check if a trigger has timed out */
    checkTriggerTimeout: function _checkTriggerTimeout() {
      var triggerTimeout = params.replay.triggerTimeout;
      if (triggerTimeout != null && triggerTimeout > 0) {
        var timeoutInfo = this.triggerTimeoutInfo;
        var curTime = new Date().getTime();

        /* we havent changed events */
        var index = this.index;
        if (timeoutInfo.index == index) {
          if (curTime - timeoutInfo.startTime > triggerTimeout * 1000) {
            return true;
          }
        } else {
          this.triggerTimeoutInfo = {startTime: curTime, index: index};
        }
      }
      return false;
    },
    triggerCheck: function _triggerCheck(v) {
      /* trigger has timed out, so no need to check trigger */
      if (this.checkTriggerTimeout()) {
        this.triggerTimeouts += 1;
        return true;
      }

      /* if there is a trigger, then check if trigger was observed */
      var triggerCondition = v.timing.triggerCondition;
      if (triggerCondition) {
        var recordEvents = this.record.events;

        for (var j = 0, jj = triggerCondition.length; j < jj; ++j) {
          var trigger = triggerCondition[j];
          var triggerEvent = this.getEvent(trigger.eventId);

          var matched = false;
          var startSeen = false;
          if (!trigger.start)
            startSeen = true;

          for (var i = recordEvents.length - 1; i >= 0; --i) {
            var e = recordEvents[i];
            if (e.meta.recordId && e.meta.recordId == trigger.start) {
              startSeen = true;
            }
            
            if (matchTrigger(e, trigger, triggerEvent)) {
              matched = true;
              break;
            }
          }

          if (!matched) {
            return false;
          }
        }
      }
      return true;
    },
    /* The main function which dispatches events to the content script */
    simulateDomEvent: function _simulateDomEvent(v) {
      try {
        /* check if event has been replayed, if so skip it */
        if (params.replay.cascadeCheck && this.checkReplayed(v)) {
          replayLog.debug('Skipping event (replayed already): ', v.type, v);
          this.incrementIndex();
          this.setNextTimeout();

          this.updateStatus(ReplayState.REPLAYING);
          return;
        }

        var meta = v.meta;
        replayLog.log('Background replay:', meta.id, v);

        /* if no matching port, try again later */
        var replayPort = this.getMatchingPort(v);
        if (!replayPort)
          return;

        if (!this.triggerCheck(v)) {
          this.setNextTimeout(params.replay.defaultWait);
          return;
        }

        /* we hopefully found a matching port, lets dispatch to that port */
        var type = v.data.type;

        try {
          if (this.getStatus() == ReplayState.REPLAYING) {
            /* clear ack */
            this.ack = null;

            /* group atomic events */
            var eventGroup = [];
            var endEvent = meta.endEventId;
            if (params.replay.atomic && endEvent) {
              var t = this.index;
              var events = this.events;
              while (t < events.length &&
                     endEvent >= events[t].meta.pageEventId &&
                     v.frame.port == events[t].frame.port) {
                if (events[t].type == 'dom')
                  eventGroup.push(events[t]);
                t++;
              }
            } else {
              eventGroup = [v];
            }

            replayPort.postMessage({type: 'dom', value: eventGroup});
            this.updateStatus(ReplayState.ACK);

            this.firstEventReplayed = true;

            replayLog.log('Sent message', eventGroup);
            replayLog.log('Start waiting for replay ack');
            this.setNextTimeout(0);
          } else {
            throw 'unknown replay state';
          }
        } catch (err) {
          replayLog.error('Error:', err.message, err);
          /* a disconnected port generally means that the page has been
           * navigated away from */
          if (err.message == 'Attempting to use a disconnected port object') {
            var strategy = params.replay.brokenPortStrategy;
            if (strategy == BrokenPortStrategy.RETRY) {
              if (v.data.cascading) {
                /* skip the rest of the events */
                this.incrementIndex();
                this.setNextTimeout(0);
              } else {
                /* remove the mapping and try again */
                delete this.portMapping[v.frame.port];
                this.setNextTimeout(0);
              }
            } else {
              throw 'unknown broken port strategy';
            }
          } else {
            err.printStackTrace();
            throw err;
          }
        }
      } catch (err) {
        replayLog.error('Error:', err.message, err);
        this.finish(err.toString());
      }
    },
    /* Remove any information adding during replay */
    resetEvent: function _resetEvent(v) {
      if (v.reset)
        v.reset = {};
    },
    receiveAck: function _receiveAck(ack) {
      this.ack = ack;
      if (ack.setTimeout)
        this.setNextTimeout(0);
    },
    screenshot: function _screenshot(text) {
      if (this.lastTab)
        saveScreenshot(this.lastTab, text)
    }
  };

  return Replay;
})();

/* The interface for the user to interact with the replayer. Can be used to
 * directly query the user. */
var User = (function UserClosure() {
  var log = getLog('user');

  function User(panel) {
    this.panel = panel;
    this.activeTab = null;
  }

  User.prototype = {
    setPanel: function _setPanel(panel) {
      this.panel = panel;
    },
    /* Query the user
     *
     * @param {string} prompt Text to show the user
     * @param {function} validatioon Check whether the answer is as exepcted
     * @param defaultAnswer Answer to use during automated periods
     * @param {function} callback Continuation to pass answer into
     */
    question: function _question(prompt, validation, defaultAnswer, callback) {
      var panel = this.panel;
      var user = this;

      if (params.replay.defaultUser) {
        callback(defaultAnswer);
      } else {
        panel.question(prompt, function(answer) {
          var sanitize = validation(answer);
          if (sanitize)
            callback(sanitize);
          else
            user.question(prompt, validation, defaultAnswer, callback);
        });
      }
    },
    /* Set which tab the user has selected */
    activatedTab: function _activatedTab(tabInfo) {
      this.activeTab = tabInfo;
    },
    getActivatedTab: function _getActivatedTab() {
      return this.activeTab;
    },
    /* Question posed from the content script */
    contentScriptQuestion: function _question(prompt, port) {
      this.question(prompt, function() {return true;}, '', function(answer) {
        port.postMessage({type: 'promptResponse', value: answer});
      });
    }
  };

  return User;
})();

/* Coordinates the model (Record, Replay, User) and view (Panel) */
var Controller = (function ControllerClosure() {
  var ctlLog = getLog('controller');

  function Controller(record, replay, scriptServer, ports) {
    this.record = record;
    this.replay = replay;
    this.scriptServer = scriptServer;
    this.ports = ports;
    this.listeners = [];
  }

  Controller.prototype = {
    /* The user started recording */
    start: function() {
      ctlLog.log('Start');
      this.record.startRecording();

      /* Update the UI */
      chrome.browserAction.setBadgeBackgroundColor({color: [255, 0, 0, 64]});
      chrome.browserAction.setBadgeText({text: 'ON'});
    },
    stop: function() {
      ctlLog.log('Stop');
      this.record.stopRecording();

      /* Update the UI */
      chrome.browserAction.setBadgeBackgroundColor({color: [0, 0, 0, 0]});
      chrome.browserAction.setBadgeText({text: 'OFF'});
    },
    reset: function() {
      ctlLog.log('Reset');
      this.record.reset();
    },
    replayRecording: function _replayRecording(config, cont) {
      ctlLog.log('Replay');
      this.stop();

      var record = this.record;
      var events = record.getEvents();
      
      if (!config)
        config = {};

      if (!config.scriptId)
        config.scriptId = record.getScriptId();

      this.replay.replay(record.getEvents(), config, cont);
      return replay;
    },
    replayScript: function(events, config, cont) {
      this.setEvents(null, events);
      return this.replayRecording(config, cont);
    },
    pause: function() {
      this.replay.pause();
    },
    restart: function() {
      this.replay.restart();
    },
    skip: function() {
      this.replay.skip();
    },
    resend: function() {
      this.replay.resend();
    },
    replayOne: function() {
      this.replay.replayOne();
    },
    loop: function(eventIds) {
      this.record.addLoop(eventIds);
    },
    next: function(eventIds) {
      this.record.addNextLoop(eventIds);
    },
    saveScript: function(name) {
      chrome.storage.local.set({scriptName: name});
      ctlLog.log('Saving script');
      var events = this.record.getEvents();
      this.scriptServer.saveScript(name, events, null, params, {}, "");
    },
    getScript: function(name) {
      ctlLog.log('Getting script');
      var controller = this;
      this.scriptServer.getScript(name,
          function(err, script) {
            if (!err) {
              chrome.storage.local.set({scriptName: name});
              controller.setEvents(script.id, script.events);
            }
          });
    },
    setEvents: function(scriptId, events) {
      this.record.setEvents(events);
      this.record.setScriptId(scriptId);
    },
    updateParams: function _updateParams() {
      this.ports.sendToAll({type: 'params', value: params});
    },
    addListener: function _addListener(callback) {
      this.listeners.push(callback);
      this.record.addListener(callback);
      this.replay.addListener(callback);
    },
    updateListeners: function _updateListeners(msg) {
      var listeners = this.listeners;
      for (var i = 0, ii = listeners.length; i < ii; ++i) {
        listeners[i](msg);
      }
    },
//    submitInput: function _submitInput(text) {
//      ctlLog.log(text);
//    },
    userUpdate: function _userUpdate(eventId, field, value) {
      ctlLog.log('Update:', eventId, field, value);
      this.record.userUpdate(eventId, field, value);
    },
    clearMessages: function _clearMessages() {
      this.updateListeners({type: 'clearMessages'});
    }
  };

  return Controller;
})();

/* Instantiate components */
var ports = new PortManager();
var scriptServer = new ScriptServer(params.server.url);

var user = new User(user);
var record = new Record(ports);
var replay = new Replay(ports, scriptServer, user);
var controller = new Controller(record, replay, scriptServer, ports);

/* Add event handlers */
var bgLog = getLog('background');

/* The first message content scripts send is to get a unique id */
function handleIdMessage(request, sender, sendResponse) {
  bgLog.log('Background receiving:', request, 'from', sender);
  if (request.type == 'getId') {
    var portId = ports.getNewId(request.value, sender);
    if (portId)
      sendResponse({type: 'id', value: portId});
  }
}

var recordHandlers = {
  'event': function(port, request) {
    record.addEvent(request.value, port.name);
  },
  'updateEvent': function(port, request) {
    record.updateEvent(request.value, port.name);
  }
}

var replayHandlers = {
  'event': function(port, request) {
    replay.record.addEvent(request.value, port.name);
  },
  'updateEvent': function(port, request) {
    replay.record.updateEvent(request.value, port.name);
  },
  'ack': function(port, request) {
    replay.receiveAck(request.value);
  },
  'prompt': function(port, request) {
    user.contentScriptQuestion(request.value, port);
  }
}

var handlers = {
  'alert': function(port, request) {
    replay.updateListeners({type: 'message',
        value: '[' + port.name + '] ' + request.value});
  },
  'getRecording': function(port, request) {
    var recStatus = record.getStatus();
    var repStatus = replay.record.getStatus();

    if (recStatus == RecordState.RECORDING)
      port.postMessage({type: 'recording', value: recStatus});
    else if (repStatus == RecordState.REPLAYING)
      port.postMessage({type: 'recording', value: repStatus});
    else
      port.postMessage({type: 'recording', value: RecordState.STOPPED});
  },
  'getParams': function(port, request) {
    port.postMessage({type: 'params', value: params});
  },
  'url': function(port, request) {
    ports.updateUrl(port, request.value);
  }
}

/* Handle messages coming from the content scripts */
function handleMessage(port, request) {
  var type = request.type;
  var state = request.state;

  bgLog.log('Handle message:', request, type, state);

  if (state == RecordState.RECORDING && type in recordHandlers) {
    recordHandlers[type](port, request);
  } else if (state == RecordState.REPLAYING && type in replayHandlers) {
    replayHandlers[type](port, request);
  } else if (type in handlers) {
    handlers[type](port, request);
  } else {
    bgLog.error('Cannot handle message:', request);
  }
}

/* Attach the event handlers to their respective events */
chrome.runtime.onMessage.addListener(handleIdMessage);

chrome.runtime.onConnect.addListener(function(port) {
  ports.connectPort(new Port(port));
});

chrome.tabs.getCurrent(function(curTab) {
  var tabId = curTab.id;
  chrome.tabs.onActivated.addListener(function(activeInfo) {
    if (activeInfo.tabId != tabId)
      user.activatedTab(activeInfo);
  });
});

chrome.tabs.onRemoved.addListener(function(tabId, removeInfo) {
  ports.removeTab(tabId);
});

/* Listen and record web requests in the trace*/

/* Need to add request bodies (only found to onBeforeRequest) to response
 * details */
var requestIdToRequestBody = {};

function addBackgroundEvent(e) {
  if (record.recordState == RecordState.RECORDING)
    record.addEvent(e);
  else if (replay.record.recordState == RecordState.REPLAYING)
    replay.record.addEvent(e);
}

function addWebRequestEvent(details, type) {
  var data = {};
  data.requestId = details.requestId;
  data.url = details.url;
  data.method = details.method;
  data.parentFrameId = details.parentFrameId;
  data.tabId = details.tabId;
  data.type = details.type;
  data.reqTimeStamp = details.timeStamp;
  data.timeStamp = (new Date()).getTime();

  if (details.requestBody)
    data.requestBody = details.requestBody;

  if (details.responseHeaders)
    data.responseHeaders = details.responseHeaders;

  var v = {};
  v.data = data;
  v.type = type;

  addBackgroundEvent(v);
}

var filter = {urls: ['http://*/*', 'https://*/*'],
  types: ['main_frame', 'sub_frame', 'script', 'object', 'xmlhttprequest']};

chrome.webRequest.onBeforeRequest.addListener(function(details) {
  if (details.url.indexOf(params.server.url) === 0)
    return;

  var requestBody = details.requestBody;
  if (requestBody)
    requestIdToRequestBody[details.requestId] = requestBody;

  bgLog.log('Request start', details);
  /* for time / space issues, lets not save start events for now */
  // addWebRequestEvent(details, 'start');
}, filter, ['requestBody']);

chrome.webRequest.onErrorOccurred.addListener(function(details) {
  if (details.url.indexOf(params.server.url) === 0)
    return;

  var requestId = details.requestId;
  if (requestId in requestIdToRequestBody)
    details.requestBody = requestIdToRequestBody[requestId];

  bgLog.log('Request error: ', details);
  addWebRequestEvent(details, 'error');
}, filter);

chrome.webRequest.onCompleted.addListener(function(details) {
  if (details.url.indexOf(params.server.url) === 0)
    return;

  var requestId = details.requestId;
  if (requestId in requestIdToRequestBody)
    details.requestBody = requestIdToRequestBody[requestId];

  bgLog.log('Request complete: ', details);
  addWebRequestEvent(details, 'completed');
}, filter);

ports.sendToAll({type: 'params', value: params});
controller.stop();

chrome.storage.local.get('scriptName', function(info) {
  var name = info.scriptName;
  if (name)
    controller.getScript(name);
});

/* Random utility methods */

/*
function printEvents() {
  var events = record.events;
  var text = JSON.stringify(events, null, 2);
  bgLog.log(text);
}

function printReplayEvents() {
  var events = replay.record.events;
  var text = JSON.stringify(events, null, 2);
  bgLog.log(text);
}
*/

function saveScreenshot(tabId, text) {
  var filename = JSON.stringify(new Date());
  if (text)
    filename += '-' + text;

  chrome.tabs.get(tabId, function(tabInfo) {
    var windowId = tabInfo.windowId;
    chrome.tabs.captureVisibleTab(windowId, {format: 'png'}, function(dataUrl) {
      filename = filename.replace(/[\,\/#!$%\^&\*;:{}=\`~()"']/g,"");
      chrome.downloads.download({
        url: dataUrl,
        filename: './snapshots/' + filename + '.png'
      });
    });
  });
}

function saveText(text, filename) {
  var filename = JSON.stringify(new Date()) + '-' + filename;

  filename = filename.replace(/[\,\/#!$%\^&\*;:{}=\`~()"']/g,"");
  chrome.downloads.download({
    url: 'data:text/plain;charset=utf-8,' + JSON.stringify(text),
    filename: './snapshots/' + filename + '.txt'
  });
}
