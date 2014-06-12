/* -*- Mode: Java; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set shiftwidth=2 tabstop=2 autoindent cindent expandtab: */

'use strict';

var domOutline = DomOutline({
    borderWidth: 2,
    onClick: onClickCapture
  }
);
var domOutlineCallback = null;

function startCapture(callback) {
  domOutlineCallback = callback;
  domOutline.start();
}

function cancelCaptureNode() {
  domOutlineCallback = null;
  domOutline.stop();
}

addonPreRecord.push(function(eventData) {
  if (domOutlineCallback) {
    if (eventData.type == 'click') { 
      domOutline.raiseClick(eventData);
    }
    return false;
  }
  return true;
});

function onClickCapture(node, event) {
  var callback = domOutlineCallback;
  if (callback) {
    domOutlineCallback = null;
    callback(node, event);
  }
}

function captureNode() {
  if (recording == RecordState.RECORDING) {
    log.log('starting node capture');
    startCapture(captureNodeReply);
  }
}

function captureNodeReply(target, event) {
  var eventMessage = {
    data: {},
    frame: {},
    meta: {},
    timing: {}
  };

  eventMessage.data.target = saveTargetInfo(target, recording);
  eventMessage.data.timeStamp = new Date().getTime();
  eventMessage.frame.URL = document.URL;
  eventMessage.meta.nodeName = target.nodeName.toLowerCase();
  eventMessage.meta.recordState = recording;

  log.log('capturing:', target, eventMessage);
  port.postMessage({type: 'capture', value: eventMessage, state: recording});

  event.preventDefault();
  event.stopImmediatePropagation();
}

handlers['capture'] = captureNode;
handlers['cancelCapture'] = cancelCaptureNode;

/* Execute a capture action
 *
 * @params captureEvent 
 */
function simulateCapture(eventRecord) {
  /* since we are simulating a new event, lets clear out any retries from
   * the last request */
  clearRetry();

  /* handle any event replaying the addons need */
  for (var j = 0, jj = addonPreTarget.length; j < jj; ++j) {
    addonPreTarget[j](eventRecord);
  }

  var eventData = eventRecord.data;
  replayLog.debug('capturing:', eventData);

  var targetInfo = eventData.target;
  var xpath = targetInfo.xpath;

  /* find the target */
  var target = getTarget(targetInfo);

  /* if no target exists, lets try to dispatch this event a little bit in
   *the future, and hope the page changes */
  if (!target) {
    if (checkTimeout(events, i)) {
      replayLog.warn('timeout finding target, skip event: ', events, i);
    }

    setTimeout(function() {
      simulateCapture(eventRecord);
    }, 1000);
    return;
  }

  if (params.replay.highlightTarget) {
    highlightNode(target, 100);
  }

  /* Scrape data */
  replayLog.log('found capture node:', target);

  var msg = {innerHtml: target.innerHTML,
             innerText: target.innerText,
             nodeName: target.nodeName.toLowerCase(),
             eventId: eventRecord.meta.id};

  port.postMessage({type: 'saveCapture', value: msg, state: recording});
}

handlers['simulateCapture'] = simulateCapture;

