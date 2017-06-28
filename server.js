/*
    ***** BEGIN LICENSE BLOCK *****
    
    Copyright © 2015 Zotero
                     https://www.zotero.org
    
    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.
    
    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.
    
    You should have received a copy of the GNU Affero General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.
    
    ***** END LICENSE BLOCK *****
*/

"use strict";

var config = require('config');
var Promise = require("bluebird");
if (config.get('longStackTraces')) {
	Promise.longStackTraces();
}

var fs = require('fs');
var url = require('url');
var domain = require('domain');
var path = require('path');
var util = require('util');

var utils = require('./utils');
var WSError = utils.WSError;
var log = require('./log');
var queue = require('./queue');
var connections = require('./connections');
var zoteroAPI = require('./zotero_api');

module.exports = function (onInit) {
	var queueData;
	var server;
	var statusIntervalID;
	var stopping;
	
	/**
	 * Handle an SQS notification
	 */
	function handleNotification(message) {
		var messageID = message.MessageId;
		var receiptHandle = message.ReceiptHandle;
		var json = JSON.parse(message.Body);
		if (!json) {
			log.error("Error parsing outer message: " + message.Body);
			return;
		}
		log.trace(json.Message);
		var data = JSON.parse(json.Message);
		if (!data) {
			log.error("Error parsing inner message: " + json.Message);
		}
		
		var apiKey = data.apiKey;
		var topic = data.topic;
		var event = data.event;
		
		switch (data.event) {
		case 'topicUpdated':
			connections.sendEventForTopic(topic, event, {
				topic: topic,
				version: data.version
			});
			break;
		
		case 'topicAdded':
			connections.handleTopicAdded(apiKey, topic);
			break;
			
		case 'topicRemoved':
			connections.handleTopicRemoved(apiKey, topic);
			break;
		
		case 'topicDeleted':
			connections.handleTopicDeleted(topic);
			break;
		}
	}
	
	
	/**
	 * Handle an HTTP incoming request
	 */
	function handleHTTPRequest(req, res, ipAddress) {
		log.info("Received HTTP request", req);
		
		var pathname = url.parse(req.url).pathname;
		
		// Health check
		if (pathname == '/health') {
			utils.end(req, res, 200);
		}
		else {
			utils.end(req, res, 400);
		}
	}
	
	
	function handleWebSocketConnection(ws) {
		log.info("Received WebSocket request", ws);
		var req = ws.upgradeReq;
		
		Promise.coroutine(function* () {
			var urlParts = url.parse(req.url, true);
			var pathname = urlParts.pathname;
			var query = urlParts.query;
			
			if (pathname != '/') {
				utils.wsEnd(ws, 404);
			}
			
			// If API key provided, subscribe to all available topics
			if (query && query.key) {
				var apiKey = query.key;
			}
			else if ('zotero-api-key' in req.headers) {
				var apiKey = req.headers['zotero-api-key'];
			}
			
			if (apiKey) {
				let topics = yield zoteroAPI.getAllKeyTopics(apiKey);
				var keyTopics = {
					apiKey: apiKey,
					topics: topics
				};
			}
			
			if (keyTopics) {
				var singleKeyRequest = true;
				var connectionAttributes = {
					singleKey: true
				};
			}
			
			var numSubscriptions = 0;
			var numTopics = 0;
			
			var connection = connections.registerConnection(ws, connectionAttributes);
			
			// Add a subscription for each topic
			if (keyTopics) {
				for (let i = 0; i < keyTopics.topics.length; i++) {
					let topic = keyTopics.topics[i];
					connections.addSubscription(connection, keyTopics.apiKey, topic);
				}
			}
			
			var data = {
				retry: config.get('retryTime') * 1000
			};
			if (singleKeyRequest) {
				data.topics = keyTopics.topics;
			}
			connections.sendEvent(connection, 'connected', data);
			
			ws.on('message', function (message) {
				handleClientMessage(ws, message);
			});
			
			ws.on('close', function () {
				log.info("WebSocket connection was closed");
				var closed = connections.deregisterConnectionByWebSocket(ws);
				if (!closed) {
					log.warn("Connection not found", ws);
				}
			});
		})()
		.catch(function (e) {
			handleError(ws, e);
		});

	}
	
	
	
	/**
	 * Handle a client request
	 */
	function handleClientMessage(ws, message) {
		var connection = connections.getConnectionByWebSocket(ws);
		
		Promise.coroutine(function* () {
			if (message.length > 1e6) {
				throw new WSError(1009);
			}
			
			message = message.trim();
			if (!message) {
				throw new WSError(400, "Message not provided");
			}
			log.debug("Receive: " + message, ws);
			try {
				var data = JSON.parse(message);
			}
			catch (e) {
				throw new WSError(400, "Error parsing JSON");
			}
			
			// Add subscriptions
			if (data.action == "createSubscriptions") {
				yield handleCreate(connection, data);
			}
			
			// Delete subscription
			else if (data.action == "deleteSubscriptions") {
				handleDelete(connection, data);
			}
			
			else if (!data.action) {
				throw new WSError(400, "'action' not provided");
			}
			
			else {
				throw new WSError(400, "Invalid action");
			}
		})()
		.catch(function (e) {
			handleError(ws, e);
		});
	}
	
	
	/**
	 * Handle a request to create new subscriptions on a connection
	 *
	 * Called from handleClientMessage
	 */
	var handleCreate = Promise.coroutine(function* (connection, data) {
		if (connection.attributes.singleKey) {
			throw new WSError(405, "Single-key connection cannot be modified");
		}
		if (data.subscriptions === undefined) {
			throw new WSError(400, "'subscriptions' array not provided");
		}
		if (!Array.isArray(data.subscriptions)) {
			throw new WSError(400, "'subscriptions' must be an array");
		}
		if (!data.subscriptions.length) {
			throw new WSError(400, "'subscriptions' array is empty");
		}
		
		let successful = {};
		let failed = [];
		
		// Verify subscriptions
		for (let i = 0; i < data.subscriptions.length; i++) {
			let sub = data.subscriptions[i];
			
			if (typeof sub != 'object') {
				throw new WSError(400, "Subscription must be an object (" + typeof sub + " given)");
			}
			
			let apiKey = sub.apiKey;
			let topics = sub.topics;
			
			if (topics && !Array.isArray(topics)) {
				throw new WSError(400, "'topics' must be an array (" + typeof topics + " given)");
			}
			
			if (apiKey) {
				var availableTopics = yield zoteroAPI.getAllKeyTopics(apiKey);
			}
			else if (!topics) {
				throw new WSError(400, "Either 'apiKey' or 'topics' must be provided");
			}
			
			// Check key's access to client-provided topics
			if (topics && topics.length) {
				for (let j = 0; j < topics.length; j++) {
					let topic = topics[j];
					if (topic[0] != '/') {
						throw new WSError(400, "Topic must begin with a slash ('" + topic + "' provided)");
					}
					let err = null;
					if (apiKey) {
						var hasAccess = availableTopics.indexOf(topic) != -1;
						if (hasAccess) {
							if (!successful[apiKey]) {
								successful[apiKey] = {
									accessTracking: false,
									topics: []
								};
							}
							if (successful[apiKey].topics.indexOf(topic) == -1) {
								successful[apiKey].topics.push(topic);
							}
						}
						else {
							err = "Topic is not valid for provided API key";
						}
					}
					else {
						var hasAccess = yield zoteroAPI.checkPublicTopicAccess(topic);
						if (hasAccess) {
							if (!successful.public) {
								successful.public = {
									accessTracking: false,
									topics: []
								};
							}
							if (successful.public.topics.indexOf(topic) == -1) {
								successful.public.topics.push(topic);
							}
						}
						else {
							err = "Topic is not accessible without an API key";
						}
					}
					if (err) {
						log.warn(err, connection);
						failed.push({
							apiKey: apiKey,
							topic: topic,
							error: err
						});
					}
				}
			}
			// If no topics provided, use all of the key's available topics
			else {
				successful[apiKey] = {
					accessTracking: true,
					topics: availableTopics
				}
			}
		}
		
		// Create subscriptions
		for (let apiKey in successful) {
			let keySubs = successful[apiKey];
			if (keySubs.accessTracking) {
				connections.enableAccessTracking(connection, apiKey);
			}
			let topics = keySubs.topics;
			for (let j = 0; j < topics.length; j++) {
				connections.addSubscription(connection, apiKey, topics[j]);
			}
		}
		
		// Generate results report
		let results = {
			subscriptions: [],
			errors: []
		};
		
		for (let apiKey in successful) {
			results.subscriptions.push({
				apiKey: apiKey != 'public' ? apiKey : undefined,
				topics: connections.getTopicsByConnectionAndKey(connection, apiKey)
			});
		}
		for (let i = 0; i < failed.length; i++) {
			let f = failed[i];
			results.errors.push({
				apiKey: f.apiKey != 'public' ? f.apiKey : undefined,
				topic: f.topic,
				error: f.error
			});
		}
		
		connections.sendEvent(connection, 'subscriptionsCreated', results);
	});
	
	
	/**
	 * Handle a request to delete one or more subscriptions on a connection
	 *
	 * Called from handleClientMessage
	 */
	function handleDelete(connection, data) {
		if (connection.attributes.singleKey) {
			throw new WSError(405, "Single-key connection cannot be modified");
		}
		if (data.subscriptions === undefined) {
			throw new WSError(400, "'subscriptions' array not provided");
		}
		if (!Array.isArray(data.subscriptions)) {
			throw new WSError(400, "'subscriptions' must be an array");
		}
		if (!data.subscriptions.length) {
			throw new WSError(400, "'subscriptions' array is empty");
		}
		
		var numRemoved = 0;
		for (let i = 0; i < data.subscriptions.length; i++) {
			let sub = data.subscriptions[i];
			if (sub.apiKey === undefined) {
				throw new WSError(400, "'apiKey' not provided");
			}
			if (sub.topic && typeof sub.topic != 'string') {
				throw new WSError(400, "'topic' must be a string");
			}
			
			numRemoved += connections.removeConnectionSubscriptionsByKeyAndTopic(
				connection, sub.apiKey, sub.topic
			);
		}
		
		if (numRemoved) {
			log.info("Deleted " + numRemoved + " "
				+ utils.plural("subscription", numRemoved), connection);
		}
		else {
			throw new WSError(409, "No matching subscription");
		}
		
		connections.sendEvent(connection, 'subscriptionsDeleted', {});
	}
	
	function handleError(ws, e) {
		if (e instanceof WSError) {
			utils.wsEnd(ws, e.code, e.message);
		}
		else {
			utils.wsEnd(ws, null, e);
		}
	}
	
	function shutdown(err) {
		if (stopping) {
			return;
		}
		stopping = true;
		
		return Promise.coroutine(function* () {
			if (server) {
				try {
					server.close(function () {
						log.info("All connections closed");
					});
				}
				catch (e) {
					log.error(e);
				}
			}
			
			try {
				connections.deregisterAllConnections();
			}
			catch (e) {
				log.error(e);
			}
			
			if (statusIntervalID) {
				clearTimeout(statusIntervalID);
			}
			
			if (queueData) {
				try {
					yield queue.terminate(queueData);
				}
				catch (e) {
					log.error(e);
				}
			}
			
			var shutdownDelay = config.get('shutdownDelay');
			log.info("Waiting " + (shutdownDelay / 1000) + " seconds before exiting");
			yield Promise.delay(shutdownDelay)
			log.info("Exiting");
			process.exit(err ? 1 : 0);
		})();
	}
	
	
	//
	//
	//
	// Main code
	//
	//
	//
	return Promise.coroutine(function* () {
		log.info("Starting up [pid: " + process.pid + "]");
		
		queueData = yield queue.create();
		var queueURL = queueData.queueURL;
		
		if (process.env.NODE_ENV != 'test') {
			process.on('SIGTERM', function () {
				log.warn("Received SIGTERM -- shutting down")
				shutdown();
			});
			
			process.on('SIGINT', function () {
				log.warn("Received SIGINT -- shutting down")
				shutdown();
			});
			
			process.on('uncaughtException', function (e) {
				log.error("Uncaught exception -- shutting down");
				log.error(e.stack);
				shutdown();
			});
			
			process.on("unhandledRejection", function (reason, promise) {
				log.error("Unhandled Promise rejection -- shutting down");
				log.error(reason.stack);
				shutdown();
			});
		}
		
		//
		// Create the HTTP(S) server
		//
		var proxyProtocol = config.has('proxyProtocol') && config.get('proxyProtocol');
		if (config.has('https') && config.get('https')) {
			if (proxyProtocol) {
				var https = require('findhit-proxywrap').proxy(require('https'));
			}
			else {
				var https = require('https');
			}
			
			var options = {
				key: fs.readFileSync(config.get('certPath')),
				cert: fs.readFileSync(config.get('certPath'))
			};
			server = https.createServer(options, function (req, res) {
				handleHTTPRequest(req, res, currentIPAddress);
			})
		}
		else {
			if (proxyProtocol) {
				var http = require('findhit-proxywrap').proxy(require('http'));
			}
			else {
				var http = require('http');
			}
			server = http.createServer(function (req, res) {
				handleHTTPRequest(req, res, currentIPAddress);
			});
		}
		
		// This is an unfortunate hack to get the real remote IP address passed via the PROXY
		// protocol rather than the proxy address. proxywrap is supposed to do this, but for some
		// reason in newer Node versions in https mode the socket we get in the connection
		// listener isn't the same modified one being passed by proxywrap, so instead we modify
		// proxywrap to pass the IP address directly, store it here, and access it from the
		// connection listener.
		if (proxyProtocol) {
			var currentIPAddress;
			server.on('ipAddress', function (ip) {
				currentIPAddress = ip;
			});
		}
		
		server.on('error', function (e) {
			log.error("Server threw error");
			log.error(e);
			shutdown(e);
		});
		
		// Give server WebSocket powers
		var WebSocketServer = require('uws').Server;
		var wss = new WebSocketServer({
			server: server,
			verifyClient: function (info, cb) {
				var pathname = url.parse(info.req.url).pathname;
				if (pathname != '/') {
					cb(false, 404, "Not Found");
				}
				else {
					cb(true);
				}
			}
		});
		wss.on('connection', function (ws) {
			ws.remoteAddress = currentIPAddress;
			handleWebSocketConnection(ws);
		});
		
		yield Promise.promisify(server.listen, server)(config.get('httpPort'), '0.0.0.0');
		
		log.info("Listening on port " + config.get('httpPort'));
		
		// Set status timer
		statusIntervalID = setInterval(function () {
			log.info(connections.status());
			if (log.showing('trace')) {
				log.info(require('util').inspect(process.memoryUsage()));
			}
		}, config.get('statusInterval') * 1000);
		
		setTimeout(function () {
			if (onInit) {
				onInit();
			}
		});
		
		// Connect to SQS queue
		while (true) {
			if (stopping) {
				break;
			}
			log.info("Getting messages from queue");
			let messages = yield queue.receiveMessages(queueURL);
			if (messages) {
				log.info("Received " + messages.length + " "
					+ utils.plural('message', messages.length) + " from queue");
				for (let i = 0; i < messages.length; i++) {
					let message = messages[i];
					handleNotification(message);
				}
				let results = yield queue.deleteMessages(queueURL, messages);
				log.info(
					"Deleted " + results.successful + " " + utils.plural('message', results.successful)
					+ (results.failed ? " (" + results.failed + " failed)" : "")
					+ " from queue"
				);
			}
		}
	})()
	.catch(function (e) {
		log.error("Caught error");
		console.log(e.stack);
		shutdown(e);
	});
};
