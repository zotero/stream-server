"use strict";

var mockery = require('mockery');
var sinon = require('sinon');

var config = require('config');
var Promise = require('bluebird');
var fs = require('fs');

var zoteroAPI = require('../zotero_api');
var WebSocket = require('./support/websocket');
var assertionCount = require('./support/assertion_count');
var assert = assertionCount.assert;
var expect = assertionCount.expect;
var testUtils = require('./support/test_utils');
var baseURL = testUtils.baseURL;
var onEvent = testUtils.onEvent;
var makeAPIKey = testUtils.makeAPIKey;


var redis = require('redis');

var redisClient = redis.createClient({
	host: config.get('redisHost')
});

redisClient.on('error', function (err) {
	console.log('Redis error', err);
});

// Start server
var defer = Promise.defer();
require('../server')(function () {
	defer.resolve();
});

var connections = [];
var topics = [];
var topicUpdatedNum = 0;
var activeConnectionNum = 0;

sinon.stub(zoteroAPI, 'getAllKeyTopics').callsFake(Promise.coroutine(function*(apiKey) {
	var names = [];
	for (var i = 0; i < 5; i++) {
		var name = '/users/' + (Math.floor(Math.random() * 999999) + 100000).toString();
		names.push(name);
		topics.push(name);
	}
	return names;
}));

function makeConnections(max, callback) {
	var total = 0;
	(function fn() {
		for (var i = 0; i < 1000 && total < max; i++, total++) {
			connect();
		}
		if (total == max) return callback();
		setTimeout(fn, 3000);
	})();
	
	function connect() {
		var apiKey = makeAPIKey();
		var ws = new WebSocket({apiKey: apiKey});
		//topics.push(apiKey);
		connections.push(ws);
		ws.on('error', function (err) {
			console.log(err);
		});
		
		ws.on('message', function (data) {
			onEvent(data, 'connected', function (fields) {
				activeConnectionNum++;
			});
			onEvent(data, 'topicUpdated', function (fields) {
				topicUpdatedNum++;
			});
		});
	}
}

function closeConnections() {
	for (var i = 0; i < connections.length; i++) {
		var connection = connections[i];
		connection.end();
	}
}

makeConnections(20000, function () {
	generateMessages();
});

function generateMessages() {
	setInterval(function () {
		for (var i = 0; i < 5; i++) {
			var n = Math.floor(Math.random() * topics.length);
			var message = {
				event: 'topicUpdated',
				topic: topics[n]
			};
			redisClient.publish(topics[n], JSON.stringify(message));
		}
	}, 1);
}

setInterval(function () {
	console.log('Active: ' + activeConnectionNum + ', received topics updates: ' + topicUpdatedNum + '/s');
	topicUpdatedNum = 0;
}, 1000);
