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
var process = require('process');
var domain = require('domain');
var path = require('path');
var util = require('util');

var utils = require('./utils');
var HTTPError = utils.HTTPError;
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
	function handleRequest(req, res, ipAddress) {
		try {
			// See "server.on('ipAddress')" above
			if (ipAddress) {
				if (req.socket.clientAddress == ipAddress) {
					log.warn("Already had correct address in socket");
				}
				req.socket.clientAddress = ipAddress;
			}
			
			// CORS
			res.setHeader("Access-Control-Allow-Origin", "*");
			res.setHeader("Access-Control-Allow-Headers", "Origin, Content-Type, Accept");
			
			// Handle the incoming request
			Promise.coroutine(function* () {
				var urlParts = url.parse(req.url, true);
				var path = urlParts.pathname;
				var query = urlParts.query;
				
				if (path == '/health') {
					throw new HTTPError(200, "OK");
				}
				if (req.method == 'POST' || req.method == 'DELETE') {
					return handleWriteRequest(req, res);
				}
				if (path != '/') {
					throw new HTTPError(404, "Not found");
				}
				if (req.headers.accept != 'text/event-stream') {
					throw new HTTPError(200, "Nothing to see here.");
				}
				// If API key provided, subscribe to all available topics
				if (query.apiKey) {
					let topics = yield zoteroAPI.getAllKeyTopics(query.apiKey);
					var keyTopics = {
						apiKey: query.apiKey,
						topics: topics
					};
				}
				else {
					var keyTopics = false;
				}
				
				req.on('close', function () {
					log.info("Closing connection");
					var closed = connections.deregisterConnectionByRequest(req);
					if (!closed) {
						log.warn("Connection not found", req);
					}
				});
				res.on('close', function () {
					log.info("Response closed", req);
				});
				res.on('finish', function () {
					log.info("Response finished", req);
				});
				
				return startStream(req, res, keyTopics);
			})()
			.catch(function (e) {
				handleRequestError(req, res, e);
			});
		}
		catch (e) {
			handleRequestError(req, res, e);
		}
	}
	
	
	//
	// Start stream for new connection
	//
	var startStream = Promise.coroutine(function* (req, res, keyTopics) {
		log.info("Starting event stream", req);
		
		if (keyTopics) {
			var singleKeyRequest = true;
			var connectionAttributes = {
				singleKey: true
			};
		}
		
		res.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache'
		});
		
		var numSubscriptions = 0;
		var numTopics = 0;
		
		var connection = connections.registerConnection(req, res, connectionAttributes);
		
		// Add a subscription for each topic
		if (keyTopics) {
			for (let i = 0; i < keyTopics.topics.length; i++) {
				let topic = keyTopics.topics[i];
				connections.addSubscription(connection, keyTopics.apiKey, topic);
			}
		}
		
		// Trigger the response headers and set the retry time (the delay before disconnected
		// clients should try to reconnect)
		connections.sendRetry(connection, config.get('retryTime') * 1000);
		var data = {};
		if (singleKeyRequest) {
			data.topics = keyTopics.topics;
		}
		else {
			data.connectionID = connection.id;
		}
		
		connections.sendEvent(connection, 'connected', JSON.stringify(data));
	});
	
	
	/**
	 * Handle a POST or DELETE request
	 */
	function handleWriteRequest(req, res) {
		var pathname = url.parse(req.url).pathname;
		
		var matches = pathname.match(/^\/connections\/([a-zA-Z0-9]+)/);
		if (!matches) {
			throw new HTTPError(404);
		}
		if (matches[1].length == connections.idLength) {
			var connection = connections.getConnectionByID(matches[1]);
		}
		if (!connection) {
			throw new HTTPError(404, "Connection not found");
		}
		
		if (req.headers['content-type'] != 'application/json') {
			throw new HTTPError(400, "Content-Type must be application/json");
		}
		
		var body = '';
		req.on('data', function (data) {
			try {
				// If more than 1MB of data passed, bail
				if (data.length > 1e6) {
					body = "";
					throw new HTTPError(413);
				}
				body += data;
			}
			catch (e) {
				handleRequestError(req, res, e);
			}
		});
		
		req.on('end', function() {
			Promise.coroutine(function* () {
				body = body.trim();
				if (!body) {
					throw new HTTPError(400, "JSON body not provided");
				}
				log.debug(req.method + " data: " + body, req);
				try {
					var data = JSON.parse(body);
				}
				catch (e) {
					throw new HTTPError(400, "Error parsing JSON body");
				}
				
				// Add subscriptions
				if (req.method == "POST") {
					yield handleCreateRequest(req, res, connection, data);
				}
				
				// Delete subscription
				else if (req.method == "DELETE") {
					handleDeleteRequest(req, res, connection, data);
				}
				else {
					throw new HTTPError(405);
				}
			})()
			.catch(function (e) {
				handleRequestError(req, res, e);
			});
		});
	}
	
	
	/**
	 * Handle a request to create new subscriptions on a connection
	 *
	 * Called from handleWriteRequest
	 */
	var handleCreateRequest = Promise.coroutine(function* (req, res, connection, data) {
		if (data.subscriptions === undefined) {
			throw new HTTPError(400, "'subscriptions' array not provided");
		}
		if (!Array.isArray(data.subscriptions)) {
			throw new HTTPError(400, "'subscriptions' must be an array");
		}
		if (!data.subscriptions.length) {
			throw new HTTPError(400, "'subscriptions' array is empty");
		}
		
		let successful = {};
		let failed = [];
		
		// Verify subscriptions
		for (let i = 0; i < data.subscriptions.length; i++) {
			let sub = data.subscriptions[i];
			
			if (typeof sub != 'object') {
				throw new HTTPError(400, "Subscription must be an object (" + typeof sub + " given)");
			}
			
			let apiKey = sub.apiKey;
			let topics = sub.topics;
			
			if (topics && !Array.isArray(topics)) {
				throw new HTTPError(400, "'topics' must be an array (" + typeof topics + " given)");
			}
			
			if (apiKey) {
				var availableTopics = yield zoteroAPI.getAllKeyTopics(apiKey);
			}
			else if (!topics) {
				throw new HTTPError(400, "Either 'apiKey' or 'topics' must be provided");
			}
			
			// Check key's access to client-provided topics
			if (topics && topics.length) {
				for (let j = 0; j < topics.length; j++) {
					let topic = topics[j];
					if (topic[0] != '/') {
						throw new HTTPError(400, "Topic must begin with a slash ('" + topic + "' provided)");
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
						log.warn(err, req);
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
		
		res.writeHead(201, {
			'Content-Type': 'application/json'
		});
		res.end(JSON.stringify(results, false, "\t"));
	});
	
	
	/**
	 * Handle a request to delete one or more subscriptions on a connection
	 *
	 * Called from handleWriteRequest
	 */
	function handleDeleteRequest(req, res, connection, data) {
		if (data.apiKey === undefined) {
			throw new HTTPError(400, "'apiKey' not provided");
		}
		if (data.topic && typeof data.topic != 'string') {
			throw new HTTPError(400, "'topic' must be a string");
		}
		
		var numRemoved = connections.removeConnectionSubscriptionsByKeyAndTopic(
			connection, data.apiKey, data.topic
		);
		if (numRemoved) {
			log.info("Deleted " + numRemoved + " "
				+ utils.plural("subscription", numRemoved), req);
		}
		else {
			throw new HTTPError(409, "No matching subscription");
		}
		throw new HTTPError(204);
	}
	
	
	function handleRequestError(req, res, e) {
		if (e instanceof HTTPError) {
			utils.end(req, res, e.code, e.message);
		}
		else {
			utils.end(req, res, 500, e);
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
			
			log.info("Waiting 2 seconds before exiting");
			yield Promise.delay(2000)
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
				log.error(reason);
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
				handleRequest(req, res, currentIPAddress);
			});
		}
		else {
			if (proxyProtocol) {
				var http = require('findhit-proxywrap').proxy(require('http'));
			}
			else {
				var http = require('http');
			}
			server = http.createServer(function (req, res) {
				handleRequest(req, res, currentIPAddress);
			});
		}
		
		// This is an unfortunate hack to get the real remote IP address passed via the PROXY
		// protocol rather than the proxy address. proxywrap is supposed to do this, but for some
		// reason the socket we get in the connection listener isn't the same modified one being
		// passed by proxywrap, so instead we modify proxywrap to pass the IP address directly,
		// store it here, and access it from the connection listener.
		//
		// DEBUG: Is it possible for this to change before handleRequest() gets called?
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
