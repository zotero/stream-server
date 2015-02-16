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
var randomstring = require('randomstring');
var utils = require('./utils');
var log = require('./log');

module.exports = function () {
	//
	// Subscription management
	//
	// A subscription is a connection, API key, and topic combination
	var connections = {};
	var topicSubscriptions = {};
	var keySubscriptions = {};
	var numConnections = 0;
	var numSubscriptions = 0;
	
	
	return {
		//
		// Connection methods
		//
		registerConnection: function (ws, attributes) {
			attributes = attributes || {};
			
			var idLength = 6;
			do {
				var connectionID = randomstring.generate(idLength);
			}
			while (connectionID in connections);
			
			var self = this;
			numConnections++;
			
			return connections[connectionID] = {
				id: connectionID,
				ws: ws,
				remoteAddress: ws.remoteAddress,
				subscriptions: [],
				accessTracking: {},
				keepaliveID: setInterval(function () {
					self.keepalive(connections[connectionID]);
				}, config.get('keepaliveInterval') * 1000),
				attributes: attributes
			};
		},
		
		//
		// Lookup
		//
		getConnectionByID: function (connectionID) {
			return connections[connectionID] || false;
		},
		
		getConnectionByWebSocket: function (ws) {
			for (let id in connections) {
				if (connections[id].ws == ws) {
					return connections[id];
				}
			}
		},
		
		/**
		 * Get subscribed topics for a given connection and key
		 */
		getTopicsByConnectionAndKey: function (connection, apiKey) {
			return connection.subscriptions.filter(function (sub) {
				return sub.apiKey == apiKey;
			})
			.map(function (sub) {
				return sub.topic;
			});
		},
		
		/**
		 * Get subscriptions with topics that match the given prefix, across all connections
		 */
		getSubscriptionsByTopicPrefix: function (prefix) {
			var subs = [];
			for (var topic in topicSubscriptions) {
				if (topic.indexOf(prefix) == 0) {
					subs = subs.concat(topicSubscriptions[topic]);
				}
			}
			return subs;
		},
		
		/**
		 * @param {String} apiKey
		 * @param {String} [topic] - If omitted, returns all subscriptions for the given API key
		 */
		getSubscriptionsByKeyAndTopic: function (apiKey, topic) {
			if (!keySubscriptions[apiKey]) return [];
			return keySubscriptions[apiKey].filter(function (sub) {
				return !topic || sub.topic == topic;
			});
		},
		
		countUniqueConnectionsInSubscriptions: function (subscriptions) {
			var connIDs = new Set;
			for (let i = 0; i < subscriptions.length; i++) {
				connIDs.add(subscriptions[i].connection.id);
			}
			return connIDs.size;
		},
		
		//
		// Key access tracking
		//
		enableAccessTracking: function (connection, apiKey) {
			connection.accessTracking[apiKey] = true;
		},
		
		getAccessTracking: function (connection, apiKey) {
			return connection.attributes.singleKey || apiKey in connection.accessTracking;
		},
		
		disableAccessTracking: function (connection, apiKey) {
			delete connection.accessTracking[apiKey];
		},
		
		/**
		 * Get connections for which key access tracking is enabled for a given API key
		 *
		 * @return {Object[]} - An array of connection objects
		 */
		getAccessTrackingConnections: function (apiKey) {
			if (!keySubscriptions[apiKey]) return [];
			
			let connectionIDs = {};
			for (let i = 0; i < keySubscriptions[apiKey].length; i++) {
				let connection = keySubscriptions[apiKey][i].connection;
				if (this.getAccessTracking(connection, apiKey)) {
					connectionIDs[connection.id] = true;
				}
			}
			return Object.keys(connectionIDs).map(function (id) {
				return this.getConnectionByID(id);
			}.bind(this));
		},
		
		//
		// Subscription management
		//
		addSubscription: function (connection, apiKey, topic) {
			if (!topicSubscriptions[topic]) {
				topicSubscriptions[topic] = [];
			}
			
			// Don't create duplicate subscriptions
			for (let i = 0; i < topicSubscriptions[topic].length; i++) {
				var sub = topicSubscriptions[topic][i];
				if (sub.connection == connection && sub.apiKey == apiKey) {
					log.info("Subscription for " + topic + " already exists");
					return;
				}
			}
			
			log.info("Adding subscription for " + topic, connection);
			
			var subscription = {
				connection: connection,
				apiKey: apiKey,
				topic: topic
			};
			
			connections[connection.id].subscriptions.push(subscription);
			if (!topicSubscriptions[topic]) {
				topicSubscriptions[topic] = [];
			}
			topicSubscriptions[topic].push(subscription);
			if (!keySubscriptions[apiKey]) {
				keySubscriptions[apiKey] = [];
			}
			keySubscriptions[apiKey].push(subscription);
			
			numSubscriptions++;
		},
		
		removeSubscription: function (subscription) {
			var connection = subscription.connection;
			var apiKey = subscription.apiKey;
			var topic = subscription.topic;
			
			log.info("Removing subscription for " + topic);
			var removed = false;
			
			this.disableAccessTracking(connection, apiKey);
			
			for (let i = 0; i < connection.subscriptions.length; i++) {
				let sub = connection.subscriptions[i];
				if (sub.apiKey == apiKey && sub.topic == topic) {
					connection.subscriptions.splice(i, 1);
					removed = true;
					break;
				}
			}
			
			for (let i = 0; i < topicSubscriptions[topic].length; i++) {
				let sub = topicSubscriptions[topic][i];
				if (sub.connection == connection && sub.apiKey == apiKey) {
					topicSubscriptions[topic].splice(i, 1);
					break;
				}
			}
			
			for (let i = 0; i < keySubscriptions[apiKey].length; i++) {
				let sub = keySubscriptions[apiKey][i];
				if (sub.connection == connection && sub.topic == topic) {
					keySubscriptions[apiKey].splice(i, 1);
					break;
				}
			}
			
			if (removed) {
				numSubscriptions--;
			}
			return removed;
		},
		
		/**
		 * Handle a topicAdded notification
		 *
		 * This sends a topicAdded event to each connection where the API key
		 * is in access-tracking mode and then adds the subscription.
		 */
		handleTopicAdded: function (apiKey, topic) {
			var conns = this.getAccessTrackingConnections(apiKey);
			log.info("Sending topicAdded to " + conns.length + " "
				+ utils.plural("client", conns.length));
			for (let i = 0; i < conns.length; i++) {
				let conn = conns[i];
				this.sendEvent(conn, 'topicAdded', {
					// Don't include API key for single-key connections
					apiKey: conn.attributes.singleKey ? undefined : apiKey,
					topic: topic
				});
				this.addSubscription(conn, apiKey, topic);
			}
		},
		
		/**
		 * Handle a topicRemoved notification
		 *
		 * Deletes the subscription with the given API key and topic and then
		 * sends out a topicRemoved for each one.
		 */
		handleTopicRemoved: function (apiKey, topic) {
			var subs = this.getSubscriptionsByKeyAndTopic(apiKey, topic);
			this.deleteAndNotifySubscriptions(subs);
		},
		
		/**
		 * Handle a topicDeleted notification
		 *
		 * Clients don't get topicDeleted notifications directly because they
		 * should know only if a key lost access to a topic, not if it was
		 * deleted, so this just finds all subscriptions with the given topic
		 * prefix and deletes them normally, including sending out a topicRemoved
		 * event for each one.
		 */
		handleTopicDeleted: function (topicPrefix) {
			var subs = this.getSubscriptionsByTopicPrefix(topicPrefix);
			this.deleteAndNotifySubscriptions(subs);
		},
		
		/**
		 * Delete each subscription and send out a topicRemoved event for it
		 */
		deleteAndNotifySubscriptions: function (subscriptions) {
			var numConns = this.countUniqueConnectionsInSubscriptions(subscriptions);
			if (!numConns) return;
			
			log.info("Sending topicRemoved for "
				+ subscriptions.length + " " + utils.plural("subscription", subscriptions.length)
				+ " to " + numConns + " " + utils.plural("connection", numConns));
			
			for (let i = 0; i < subscriptions.length; i++) {
				let sub = subscriptions[i];
				let conn = sub.connection;
				// Don't include API key for single-key connections or public topics
				let skipKey = conn.attributes.singleKey || sub.apiKey == 'public';
				this.removeSubscription(sub);
				this.sendEvent(conn, 'topicRemoved', {
					apiKey: skipKey ? undefined : sub.apiKey,
					topic: sub.topic
				});
			}
		},
		
		/**
		 * Delete subscriptions with the given API key and an optional topic for a given
		 * connection
		 *
		 * If a topic isn't provided, all subscriptions for the given API key are deleted
		 *
		 * @param {String} apiKey
		 * @param {String} [topic=false]
		 * @return {Integer} - Number of subscriptions removed
		 */
		removeConnectionSubscriptionsByKeyAndTopic: function (connection, apiKey, topic) {
			if (!keySubscriptions[apiKey]) {
				return 0;
			}
			var subs = this.getSubscriptionsByKeyAndTopic(apiKey, topic).filter(function (sub) {
				return sub.connection == connection;
			});
			for (var i = 0; i < subs.length; i++) {
				this.removeSubscription(subs[i]);
			}
			return subs.length;
		},
		
		deregisterConnection: function (conn) {
			conn.subscriptions.concat().forEach(this.removeSubscription.bind(this));
			this.closeConnection(conn);
		},
		
		closeConnection: function (conn) {
			log.info("Closing connection", conn);
			clearInterval(conn.keepaliveID);
			conn.ws.close()
			numConnections--;
			delete connections[conn.id];
		},
		
		deregisterConnectionByWebSocket: function (ws) {
			var conn = this.getConnectionByWebSocket(ws);
			if (conn) {
				this.deregisterConnection(conn);
				return true;
			}
			return false
		},
		
		deregisterAllConnections: function () {
			log.info("Closing all connections");
			Object.keys(connections).forEach(function (id) {
				this.deregisterConnection(connections[id]);
				
			}.bind(this));
		},
		
		
		//
		// Event methods
		//
		sendEvent: function (connection, event, data) {
			var json = {
				event: event
			};
			for (let i in data) {
				json[i] = data[i];
			}
			json = JSON.stringify(json);
			log.debug("Send: " + json, connection);
			connection.ws.send(json);
		},
		
		/**
		 * Send an event to all matching topics
		 *
		 * @param {String} topic
		 * @param {String} event - Event name. Can be null to send data-only event
		 * @param {Object} data - Data to send. Will be JSONified.
		 */
		sendEventForTopic: function (topic, event, data) {
			if (!topicSubscriptions[topic] || !topicSubscriptions[topic].length) return;
			
			var logEventName = (event + " event") || "data";
			var numSubs = topicSubscriptions[topic].length;
			log.info("Sending " + logEventName + " for topic " + topic + " to "
				+ numSubs + " " + utils.plural("client", numSubs));
			
			for (let i = 0; i < topicSubscriptions[topic].length; i++) {
				let sub = topicSubscriptions[topic][i];
				this.sendEvent(sub.connection, event, data);
			}
		},
		
		/**
		 * Send an event to all matching topics
		 *
		 * TODO: delete?
		 *
		 * @param {String} topic
		 * @param {String} event - Event name. Can be null to send data-only event.
		 * @param {Object} data - Data to send. Will be JSONified. 'apiKey' will be removed
		 *                        for single-key requests.
		 */
		sendEventForKeyAndTopic: function (apiKey, topic, event, data) {
			if (!keySubscriptions[apiKey]) return;
			
			var logEventName = (event + " event") || "data";
			
			var subs = keySubscriptions[apiKey].filter(function (sub) {
				return sub.topic == topic;
			});
			if (!subs.length) {
				return;
			}
			
			log.info("Sending " + logEventName + " to "
				+ subs.length + " " + utils.plural("client", subs.length));
			
			for (let i = 0; i < subs.length; i++) {
				let sub = subs[i];
				// If single-key request, remove API key from data
				if (sub.connection.attributes.singleKey) {
					delete data.apiKey;
				}
				this.sendEvent(sub.connection, event, data);
			}
		},
		
		keepalive: function (connection) {
			connection.ws.ping();
		},
		
		status: function () {
			return "["
				+ numConnections + " " + utils.plural("connection", numConnections)
				+ ", "
				+ numSubscriptions + " " + utils.plural("subscription", numSubscriptions)
				+ "]";
		}
	}
}();
