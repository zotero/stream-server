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

var mockery = require('mockery');
var sinon = require('sinon');

var config = require('config');
var Promise = require('bluebird');
var fs = require('fs');
var requestAsync = Promise.promisify(require('request'));

mockery.registerSubstitute('./queue', './test/support/queue_mock');
mockery.enable();
mockery.warnOnUnregistered(false);

var zoteroAPI = require('../zotero_api');
var connections = require('../connections');
var queue = require('./support/queue_mock');
var EventStream = require('./support/event_stream');
var assertionCount = require('./support/assertion_count');
var assert = assertionCount.assert;
var expect = assertionCount.expect;
var testUtils = require('./support/test_utils');
var baseURL = testUtils.baseURL;
var onEvent = testUtils.onEvent;
var makeAPIKey = testUtils.makeAPIKey;


// Start server
var defer = Promise.defer();
require('../streamer')(function () {
	defer.resolve();
});


describe("Streamer Tests:", function () {
	// Wait for server initialization
	// TODO: Emit an event for this
	before(function (done) {
		defer.promise.then(function () {
			done();
		});
	});
	
	beforeEach(assertionCount.reset);
	afterEach(assertionCount.check);
	
	beforeEach(function () {
		console.log((new Array(63)).join("="));
	});
	afterEach(function () {
		console.log((new Array(63)).join("=") + "\n");
	});
	
	describe("Health check", function () {
		it('should return 200', function () {
			return requestAsync(baseURL + 'health')
			.spread(function (response, body) {
				assert.equal("OK", body);
			});
		})
	})
	
	
	describe("Single-key event stream", function () {
		it('should return 200', function (done) {
			var eventStream = new EventStream;
			eventStream.on('response', function (response, body) {
				eventStream.end();
				assert.equal(response.statusCode, 200);
				done();
			});
		});
		
		it('should include a retry value', function (done) {
			var eventStream = new EventStream;
			eventStream.on('data', function (data) {
				onEvent(data, null, function (fields) {
					eventStream.end();
					if (fields.retry) {
						assert.equal(fields.retry, config.get('retryTime') * 1000);
						done();
					}
				});
			});
		});
		
		it('should reject unknown API keys', function (done) {
			var apiKey = "INVALID" + makeAPIKey().substr(7);
			var eventStream = new EventStream({ apiKey: apiKey }, function (err, response, body) {
				if (err) throw err;
				assert.equal(response.statusCode, 403);
				assert.equal(body, "Invalid API key");
				done();
			});
		});
		
		it('should include all accessible topics', function (done) {
			var apiKey = makeAPIKey();
			var topics = ['/users/123456', '/groups/234567'];
			
			sinon.stub(zoteroAPI, 'getAllKeyTopics')
				.withArgs(apiKey)
				.returns(Promise.resolve(topics));
			
			var eventStream = new EventStream({ apiKey: apiKey });
			eventStream.on('data', function (data) {
				onEvent(data, 'connected', function (fields) {
					eventStream.end();
					zoteroAPI.getAllKeyTopics.restore();
					
					assert.typeOf(fields.data.topics, 'array');
					assert.lengthOf(fields.data.topics, topics.length);
					assert.sameMembers(fields.data.topics, topics);
					done();
				});
			});
		});
		
		it('should not return a connectionID', function (done) {
			var apiKey = makeAPIKey();
			
			sinon.stub(zoteroAPI, 'getAllKeyTopics')
				.withArgs(apiKey)
				.returns(Promise.resolve(['/users/123456']));
			
			var eventStream = new EventStream({ apiKey: apiKey });
			eventStream.on('data', function (data) {
				onEvent(data, 'connected', function (fields) {
					eventStream.end();
					zoteroAPI.getAllKeyTopics.restore();
					
					assert.isUndefined(fields.data.connectionID);
					done();
				});
			});
		});
		
		it('should add a topic on topicAdded for key', function (done) {
			var apiKey = makeAPIKey();
			var topics = ['/users/123456'];
			var newTopic = '/groups/234567';
			
			sinon.stub(zoteroAPI, 'getAllKeyTopics')
				.withArgs(apiKey)
				.returns(Promise.resolve(topics));
			
			var eventStream = new EventStream({ apiKey: apiKey });
			eventStream.on('data', function (data) {
				onEvent(data, 'connected', function (fields) {
					zoteroAPI.getAllKeyTopics.restore();
					
					eventStream.on('data', function (data) {
						onEvent(data, 'topicAdded', function (fields) {
							// API key shouldn't be passed to single-key request
							assert.isUndefined(fields.data.apiKey);
							assert.equal(fields.data.topic, newTopic);
							assert.lengthOf(Object.keys(fields.data), 1);
							
							var allTopics = topics.concat([newTopic]);
							
							var topicUpdatedCalled = 0;
							eventStream.on('data', function (data) {
								onEvent(data, 'topicUpdated', function (fields) {
									assert.equal(fields.data.topic, allTopics[topicUpdatedCalled]);
									topicUpdatedCalled++;
									if (topicUpdatedCalled == allTopics.length) {
										eventStream.end();
										done();
									}
								});
							});
							
							// Send topicUpdated to old and new topics
							queue.postMessages(allTopics.map(function (topic) {
								return {
									event: "topicUpdated",
									topic: topic
								};
							}));
						});
					});
					
					// Send topicAdded
					queue.postMessages({
						event: "topicAdded",
						apiKey: apiKey,
						topic: newTopic
					});
				});
			});
		});
		
		it('should delete a topic on topicRemoved', function (done) {
			expect(4);
			
			var apiKey = makeAPIKey();
			var topics = ['/users/123456', '/groups/234567'];
			var topicToRemove = '/groups/234567';
			
			sinon.stub(zoteroAPI, 'getAllKeyTopics')
				.withArgs(apiKey)
				.returns(Promise.resolve(topics));
			
			var eventStream = new EventStream({ apiKey: apiKey });
			eventStream.on('data', function (data) {
				onEvent(data, 'connected', function (fields) {
					zoteroAPI.getAllKeyTopics.restore();
					
					eventStream.on('data', function (data) {
						onEvent(data, 'topicRemoved', Promise.coroutine(function* (fields) {
							// API key shouldn't be passed to single-key request
							assert.isUndefined(fields.data.apiKey);
							assert.equal(fields.data.topic, topicToRemove);
							assert.lengthOf(Object.keys(fields.data), 1);
							
							var remainingTopics = topics.slice(0, -1);
							
							var topicUpdatedCalled = 0;
							eventStream.on('data', function (data) {
								onEvent(data, 'topicUpdated', function (fields) {
									assert.equal(fields.data.topic, remainingTopics[topicUpdatedCalled]);
									topicUpdatedCalled++;
								});
							});
							
							// Send topicUpdated to all topics
							queue.postMessages(topics.map(function (topic) {
								return {
									event: "topicUpdated",
									topic: topic
								};
							}));
							
							// Give topicUpdated time to be erroneously called
							yield Promise.delay(100);
							eventStream.end();
							done();
						}));
					});
					
					// Send topicRemoved
					queue.postMessages({
						event: "topicRemoved",
						apiKey: apiKey,
						topic: topicToRemove
					});
				});
			});
		});
	})
	
	
	describe("Multi-key event stream", function () {
		it('should return 200', function (done) {
			var eventStream = new EventStream;
			eventStream.on('response', function (response, body) {
				eventStream.end();
				assert.equal(response.statusCode, 200);
				done();
			});
		});
		
		it('should include a retry value', function (done) {
			var eventStream = new EventStream;
			eventStream.on('data', function (data) {
				onEvent(data, null, function (fields) {
					eventStream.end();
					if (fields.retry) {
						assert.equal(fields.retry, config.get('retryTime') * 1000);
						done();
					}
				});
			});
		});
		
		it('should return a connectionID', function (done) {
			var eventStream = new EventStream;
			eventStream.on('data', function (data) {
				onEvent(data, 'connected', function (fields) {
					eventStream.end();
					let connectionID = fields.data.connectionID;
					assert.lengthOf(connectionID, connections.idLength);
					done();
				});
			});
		});
		
		it("should add subscriptions for all of an API key's topics", function (done) {
			expect(7);
			
			var eventStream = new EventStream;
			eventStream.on('data', function (data) {
				onEvent(data, 'connected', function (fields) {
					let connectionID = fields.data.connectionID;
					
					var apiKey = makeAPIKey();
					var topics = ['/users/123456', '/groups/234567'];
					var ignoredTopics = ['/groups/345678'];
					
					// Listen for update notifications
					var topicUpdatedCalled = 0;
					eventStream.on('data', function (data) {
						onEvent(data, 'topicUpdated', function (fields) {
							assert.equal(fields.data.topic, topics[topicUpdatedCalled]).done(function () {
								eventStream.end();
								done();
							});
							topicUpdatedCalled++;
						});
					});
					
					sinon.stub(zoteroAPI, 'getAllKeyTopics')
						.withArgs(apiKey)
						.returns(Promise.resolve(topics));
					
					// Add a subscription
					var req2 = requestAsync({
						method: 'post',
						url: baseURL + "connections/" + connectionID,
						body: {
							subscriptions: [{
								apiKey: apiKey
							}]
						},
						json: true
					})
					.spread(function (response, body) {
						zoteroAPI.getAllKeyTopics.restore();
						assert.equal(response.statusCode, 201);
						assert.typeOf(body.subscriptions, 'array');
						assert.lengthOf(body.subscriptions, 1);
						assert.equal(body.subscriptions[0].apiKey, apiKey);
						assert.sameMembers(body.subscriptions[0].topics, topics);
						
						// Trigger notification on subscribed topics, which should trigger
						// topicUpdated above
						queue.postMessages(topics.concat(ignoredTopics).map(function (topic) {
							return {
								event: "topicUpdated",
								topic: topic
							};
						}));
					});
				});
			})
		});
		
		it("should add specific provided subscriptions", function (done) {
			expect(7);
			
			var eventStream = new EventStream;
			eventStream.on('data', function (data) {
				onEvent(data, 'connected', function (fields) {
					let connectionID = fields.data.connectionID;
					
					var apiKey = makeAPIKey();
					var topics = ['/users/123456', '/groups/234567'];
					var ignoredTopics = ['/groups/345678'];
					
					// Listen for update notifications
					var topicUpdatedCalled = 0;
					eventStream.on('data', function (data) {
						onEvent(data, 'topicUpdated', function (fields) {
							assert.equal(fields.data.topic, topics[topicUpdatedCalled]).done(function () {
								eventStream.end();
								done();
							});
							topicUpdatedCalled++;
						});
					});
					
					sinon.stub(zoteroAPI, 'getAllKeyTopics')
						.withArgs(apiKey)
						.returns(Promise.resolve(topics));
					
					// Add a subscription
					let req2 = requestAsync({
						method: 'post',
						url: baseURL + "connections/" + connectionID,
						body: {
							subscriptions: [{
								apiKey: apiKey,
								topics: topics
							}]
						},
						json: true
					})
					.spread(function (response, body) {
						zoteroAPI.getAllKeyTopics.restore();
						assert.equal(response.statusCode, 201);
						assert.typeOf(body.subscriptions, 'array');
						assert.lengthOf(body.subscriptions, 1);
						assert.equal(body.subscriptions[0].apiKey, apiKey);
						assert.sameMembers(body.subscriptions[0].topics, topics);
						
						// Trigger notification on subscribed topic, which should trigger
						// topicUpdated above
						queue.postMessages(topics.concat(ignoredTopics).map(function (topic) {
							return {
								event: "topicUpdated",
								topic: topic
							};
						}));
					});
				});
			})
		});
		

		it("should add provided public subscriptions", function (done) {
			expect(7);
			
			var eventStream = new EventStream;
			eventStream.on('data', function (data) {
				onEvent(data, 'connected', function (fields) {
					let connectionID = fields.data.connectionID;
					
					var topics = ['/groups/123456', '/groups/234567'];
					var ignoredTopics = ['/groups/345678'];
					
					// Listen for update notifications
					var topicUpdatedCalled = 0;
					eventStream.on('data', function (data) {
						onEvent(data, 'topicUpdated', function (fields) {
							assert.equal(fields.data.topic, topics[topicUpdatedCalled]).done(function () {
								eventStream.end();
								done();
							});
							topicUpdatedCalled++;
						});
					});
					
					var stub = sinon.stub(zoteroAPI, 'checkPublicTopicAccess');
					for (let i = 0; i < topics.length; i++) {
						stub.withArgs(topics[i]).returns(Promise.resolve(true));
					}
					stub.returns(Promise.resolve(false));
					
					// Add a subscription
					let req2 = requestAsync({
						method: 'post',
						url: baseURL + "connections/" + connectionID,
						body: {
							subscriptions: [
								// No reason client should do this, but separate subscriptions
								// should be merged together
								{
									topics: [
										topics[0]
									]
								},
								{
									topics: [
										topics[1]
									]
								}
							]
						},
						json: true
					})
					.spread(function (response, body) {
						stub.restore();
						assert.equal(response.statusCode, 201);
						assert.typeOf(body.subscriptions, 'array');
						assert.lengthOf(body.subscriptions, 1);
						assert.isUndefined(body.subscriptions[0].apiKey);
						assert.sameMembers(body.subscriptions[0].topics, topics);
						
						// Trigger notification on subscribed topics, which should trigger
						// topicUpdated above
						queue.postMessages(topics.concat(ignoredTopics).map(function (topic) {
							return {
								event: "topicUpdated",
								topic: topic
							};
						}));
					});
				});
			})
		});
		
		it("should ignore inaccessible subscriptions in add requests", function (done) {
			expect(14);
			
			var eventStream = new EventStream;
			eventStream.on('data', function (data) {
				onEvent(data, 'connected', function (fields) {
					let connectionID = fields.data.connectionID;
					
					var apiKey = makeAPIKey();
					var topics = ['/groups/234567'];
					var inaccessibleKeyTopics = ['/groups/345678'];
					var inaccessiblePublicTopics = ['/groups/456789'];
					var inaccessibleTopics = inaccessibleKeyTopics.concat(inaccessiblePublicTopics);
					
					// Listen for update notifications
					var topicUpdatedCalled = 0;
					eventStream.on('data', function (data) {
						onEvent(data, 'topicUpdated', function (fields) {
							assert.equal(fields.data.topic, topics[topicUpdatedCalled]).done(function () {
								eventStream.end();
								done();
							});
							topicUpdatedCalled++;
						});
					});
					
					sinon.stub(zoteroAPI, 'getAllKeyTopics')
						.withArgs(apiKey)
						.returns(Promise.resolve(topics));
					
					// Add a subscription
					let req2 = requestAsync({
						method: 'post',
						url: baseURL + "connections/" + connectionID,
						body: {
							subscriptions: [
								{
									apiKey: apiKey,
									topics: topics.concat(inaccessibleKeyTopics)
								},
								{
									topics: inaccessiblePublicTopics
								},
							]
						},
						json: true
					})
					.spread(function (response, body) {
						zoteroAPI.getAllKeyTopics.restore();
						assert.equal(response.statusCode, 201);
						assert.typeOf(body.subscriptions, 'array');
						assert.lengthOf(body.subscriptions, 1);
						assert.equal(body.subscriptions[0].apiKey, apiKey);
						assert.sameMembers(body.subscriptions[0].topics, topics);
						
						assert.typeOf(body.errors, 'array');
						assert.lengthOf(body.errors, inaccessibleTopics.length);
						assert.equal(body.errors[0].apiKey, apiKey);
						assert.equal(body.errors[0].topic, inaccessibleKeyTopics[0]);
						assert.equal(body.errors[0].error, "Topic is not valid for provided API key");
						assert.isUndefined(body.errors[1].apiKey);
						assert.equal(body.errors[1].topic, inaccessiblePublicTopics[0]);
						assert.equal(body.errors[1].error, "Topic is not accessible without an API key");
						
						queue.postMessages(topics.concat(inaccessibleTopics).map(function (topic) {
							return {
								event: "topicUpdated",
								topic: topic
							};
						}));
					});
				});
			})
		});
		
		it("should delete all topics of a provided API key", function (done) {
			expect(2);
			
			var eventStream = new EventStream;
			eventStream.on('data', function (data) {
				onEvent(data, 'connected', Promise.coroutine(function* (fields) {
					let connectionID = fields.data.connectionID;
					
					var apiKey = makeAPIKey();
					var topics = ['/users/123456', '/groups/234567'];
					
					sinon.stub(zoteroAPI, 'getAllKeyTopics')
						.withArgs(apiKey)
						.returns(Promise.resolve(topics));
					
					// Add subscriptions
					var response = yield requestAsync({
						method: 'post',
						url: baseURL + "connections/" + connectionID,
						body: {
							subscriptions: [{
								apiKey: apiKey
							}]
						},
						json: true
					}).get(0);
					assert.equal(response.statusCode, 201);
					
					// Delete subscriptions
					response = yield requestAsync({
						method: 'delete',
						url: baseURL + "connections/" + connectionID,
						body: {
							apiKey: apiKey
						},
						json: true
					})
					.get(0);
					assert.equal(response.statusCode, 204);
					
					zoteroAPI.getAllKeyTopics.restore();
					
					// Listen for update notifications
					eventStream.on('data', function (data) {
						onEvent(data, 'topicUpdated', function (fields) {
							assert.fail(fields.data.topic, "",
								"topicUpdated shouldn't be called after deletion");
						});
					});
					
					// Trigger notification on subscribed topics, which should NOT trigger
					// topicUpdated above
					queue.postMessages(topics.map(function (topic) {
						return {
							event: "topicUpdated",
							topic: topic
						};
					}));
					
					// Give topicUpdated time to be erroneously called
					yield Promise.delay(100);
					eventStream.end();
					done();
				}));
			})
		});
		
		it("should delete a specific API key/topic pair ", function (done) {
			expect(5);
			
			var eventStream = new EventStream;
			eventStream.on('data', function (data) {
				onEvent(data, 'connected', Promise.coroutine(function* (fields) {
					let connectionID = fields.data.connectionID;
					
					var apiKey1 = makeAPIKey();
					var apiKey2 = makeAPIKey();
					var topics1 = ['/users/123456', '/groups/234567'];
					var topics2 = ['/users/234567', '/groups/234567'];
					// Should receive notifications for all topics, since the deleted topic
					// exists for both API keys
					var allTopics = ['/users/123456', '/users/234567', '/groups/234567'];
					var topicToDelete = '/groups/234567';
					
					sinon.stub(zoteroAPI, 'getAllKeyTopics')
						.withArgs(apiKey1)
						.returns(Promise.resolve(topics1))
						.withArgs(apiKey2)
						.returns(Promise.resolve(topics2));
					
					// Add subscriptions
					var response = yield testUtils.addSubscriptionsByKeys(connectionID, [apiKey1, apiKey2]);
					assert.equal(response.statusCode, 201);
					
					// Delete subscriptions
					response = yield requestAsync({
						method: 'delete',
						url: baseURL + "connections/" + connectionID,
						body: {
							apiKey: apiKey1,
							topic: topicToDelete
						},
						json: true
					})
					.get(0);
					assert.equal(response.statusCode, 204);
					
					zoteroAPI.getAllKeyTopics.restore();
					
					// Listen for update notifications
					var topicUpdatedCalled = 0;
					eventStream.on('data', function (data) {
						onEvent(data, 'topicUpdated', function (fields) {
							assert.equal(fields.data.topic, allTopics[topicUpdatedCalled]).done(function () {
								eventStream.end();
								done();
							});
							topicUpdatedCalled++;
						});
					});
					
					// Trigger notification on all topics
					queue.postMessages(allTopics.map(function (topic) {
						return {
							event: "topicUpdated",
							topic: topic
						};
					}));
				}));
			})
		})
		
		it('should add a topic on topicAdded for key', function (done) {
			expect(8);
			
			var eventStream = new EventStream();
			eventStream.on('data', function (data) {
				onEvent(data, 'connected', Promise.coroutine(function* (fields) {
					var connectionID = fields.data.connectionID;
					
					var apiKey1 = makeAPIKey();
					var apiKey2 = makeAPIKey();
					var topics1 = ['/users/123456', '/groups/345678'];
					var topics2 = ['/users/234567'];
					var newTopic = '/groups/456789';
					
					sinon.stub(zoteroAPI, 'getAllKeyTopics')
						.withArgs(apiKey1)
						.returns(Promise.resolve(topics1))
						.withArgs(apiKey2)
						.returns(Promise.resolve(topics2));
					
					// Add subscriptions
					var response = yield testUtils.addSubscriptionsByKeys(connectionID, [apiKey1, apiKey2]);
					assert.equal(response.statusCode, 201);
					
					zoteroAPI.getAllKeyTopics.restore();
					
					eventStream.on('data', function (data) {
						onEvent(data, 'topicAdded', function (fields) {
							// API key shouldn't be passed to single-key request
							assert.equal(fields.data.apiKey, apiKey1);
							assert.equal(fields.data.topic, newTopic);
							assert.lengthOf(Object.keys(fields.data), 2);
							
							var allTopics = topics1.concat(topics2).concat([newTopic]);
							
							var topicUpdatedCalled = 0;
							eventStream.on('data', function (data) {
								onEvent(data, 'topicUpdated', function (fields) {
									assert.equal(fields.data.topic, allTopics[topicUpdatedCalled]);
									topicUpdatedCalled++;
									if (topicUpdatedCalled == allTopics.length) {
										eventStream.end();
										done();
									}
								});
							});
							
							// Send topicUpdated to old and new topics
							queue.postMessages(allTopics.map(function (topic) {
								return {
									event: "topicUpdated",
									topic: topic
								};
							}));
						});
					});
					
					// Send topicAdded
					queue.postMessages({
						event: "topicAdded",
						apiKey: apiKey1,
						topic: newTopic
					});
				}));
			});
		})
		
		it('should delete a topic on topicRemoved', function (done) {
			expect(6);
			
			var eventStream = new EventStream();
			eventStream.on('data', function (data) {
				onEvent(data, 'connected', Promise.coroutine(function* (fields) {
					var connectionID = fields.data.connectionID;
					
					var apiKey1 = makeAPIKey();
					var apiKey2 = makeAPIKey();
					var topics1 = ['/users/123456', '/groups/345678'];
					var topics2 = ['/users/234567'];
					var topicToRemove = '/groups/345678';
					
					sinon.stub(zoteroAPI, 'getAllKeyTopics')
						.withArgs(apiKey1)
						.returns(Promise.resolve(topics1))
						.withArgs(apiKey2)
						.returns(Promise.resolve(topics2));
					
					// Add subscriptions
					var response = yield testUtils.addSubscriptionsByKeys(connectionID, [apiKey1, apiKey2]);
					assert.equal(response.statusCode, 201);
					
					zoteroAPI.getAllKeyTopics.restore();
					
					eventStream.on('data', function (data) {
						onEvent(data, 'topicRemoved', Promise.coroutine(function* (fields) {
							assert.equal(fields.data.apiKey, apiKey1);
							assert.equal(fields.data.topic, topicToRemove);
							assert.lengthOf(Object.keys(fields.data), 2);
							
							var remainingTopics = topics1.slice(0, -1).concat(topics2);
							
							var topicUpdatedCalled = 0;
							eventStream.on('data', function (data) {
								onEvent(data, 'topicUpdated', function (fields) {
									assert.equal(fields.data.topic, remainingTopics[topicUpdatedCalled]);
									topicUpdatedCalled++;
								});
							});
							
							// Send topicUpdated to all topics
							queue.postMessages(topics1.concat(topics2).map(function (topic) {
								return {
									event: "topicUpdated",
									topic: topic
								};
							}));
							
							// Give topicUpdated time to be erroneously called
							yield Promise.delay(100);
							eventStream.end();
							done();
						}));
					});
					
					// Send topicRemoved
					queue.postMessages({
						event: "topicRemoved",
						apiKey: apiKey1,
						topic: topicToRemove
					});
				}));
			});
		})
		
		it('should ignore a topicRemoved for a different API key', function (done) {
			expect(2);
			
			var eventStream = new EventStream();
			eventStream.on('data', function (data) {
				onEvent(data, 'connected', Promise.coroutine(function* (fields) {
					var connectionID = fields.data.connectionID;
					
					var apiKey1 = makeAPIKey();
					var apiKey2 = makeAPIKey();
					var topics1 = ['/users/123456', '/groups/345678'];
					var topics2 = ['/users/234567'];
					var topicToRemove = '/groups/345678';
					var allTopics = topics1.concat(topics2);
					
					sinon.stub(zoteroAPI, 'getAllKeyTopics')
						.withArgs(apiKey1)
						.returns(Promise.resolve(topics1))
						.withArgs(apiKey2)
						.returns(Promise.resolve(topics2));
					
					// Add subscriptions
					var response = yield testUtils.addSubscriptions(connectionID, apiKey1);
					assert.equal(response.statusCode, 201);
					var response = yield testUtils.addSubscriptions(connectionID, apiKey2);
					assert.equal(response.statusCode, 201);
					
					zoteroAPI.getAllKeyTopics.restore();
					
					eventStream.on('data', function (data) {
						onEvent(data, 'topicRemoved', Promise.coroutine(function* (fields) {
							throw new Error("topicRemoved shouldn't be received for non-matching API key");
						}));
					});
					
					// Send topicRemoved on wrong API key
					queue.postMessages({
						event: "topicRemoved",
						apiKey: apiKey2,
						topic: topicToRemove
					});
					
					// Give topicRemoved time to be erroneously called
					yield Promise.delay(100);
					eventStream.end();
					done();
				}));
			});
		})
		
		it('should delete key-based topics on topicDeleted', function (done) {
			expect(6);
			
			var eventStream = new EventStream();
			eventStream.on('data', function (data) {
				onEvent(data, 'connected', Promise.coroutine(function* (fields) {
					var connectionID = fields.data.connectionID;
					
					var apiKey1 = makeAPIKey();
					var apiKey2 = makeAPIKey();
					var topics1 = ['/users/123456', '/groups/345678'];
					var topics2 = ['/users/234567'];
					var topicToRemove = '/groups/345678';
					
					sinon.stub(zoteroAPI, 'getAllKeyTopics')
						.withArgs(apiKey1)
						.returns(Promise.resolve(topics1))
						.withArgs(apiKey2)
						.returns(Promise.resolve(topics2));
					
					// Add subscriptions
					var response = yield testUtils.addSubscriptionsByKeys(connectionID, [apiKey1, apiKey2]);
					assert.equal(response.statusCode, 201);
					
					zoteroAPI.getAllKeyTopics.restore();
					
					eventStream.on('data', function (data) {
						onEvent(data, 'topicRemoved', Promise.coroutine(function* (fields) {
							assert.equal(fields.data.apiKey, apiKey1);
							assert.equal(fields.data.topic, topicToRemove);
							assert.lengthOf(Object.keys(fields.data), 2);
							
							var remainingTopics = topics1.slice(0, -1).concat(topics2);
							
							var topicUpdatedCalled = 0;
							eventStream.on('data', function (data) {
								onEvent(data, 'topicUpdated', function (fields) {
									assert.equal(fields.data.topic, remainingTopics[topicUpdatedCalled]);
									topicUpdatedCalled++;
								});
							});
							
							// Send topicUpdated to all topics
							queue.postMessages(topics1.concat(topics2).map(function (topic) {
								return {
									event: "topicUpdated",
									topic: topic
								};
							}));
							
							// Give topicUpdated time to be erroneously called
							yield Promise.delay(100);
							eventStream.end();
							done();
						}));
					});
					
					// Send topicRemoved
					queue.postMessages({
						event: "topicDeleted",
						topic: topicToRemove
					});
				}));
			});
		})
		
		it('should delete a public topic on topicDeleted', function (done) {
			expect(5);
			
			var eventStream = new EventStream();
			eventStream.on('data', function (data) {
				onEvent(data, 'connected', Promise.coroutine(function* (fields) {
					var connectionID = fields.data.connectionID;
					
					var topics = ['/groups/234567', '/groups/345678'];
					var topicToRemove = '/groups/345678';
					
					var stub = sinon.stub(zoteroAPI, 'checkPublicTopicAccess');
					for (let i = 0; i < topics.length; i++) {
						stub.withArgs(topics[i]).returns(Promise.resolve(true));
					}
					stub.returns(Promise.resolve(false));
					
					// Add subscriptions
					var response = yield testUtils.addSubscriptions(connectionID, undefined, topics);
					assert.equal(response.statusCode, 201);
					
					stub.restore();
					
					eventStream.on('data', function (data) {
						onEvent(data, 'topicRemoved', Promise.coroutine(function* (fields) {
							assert.isUndefined(fields.data.apiKey);
							assert.equal(fields.data.topic, topicToRemove);
							assert.lengthOf(Object.keys(fields.data), 1);
							
							var remainingTopics = topics.slice(0, -1);
							
							var topicUpdatedCalled = 0;
							eventStream.on('data', function (data) {
								onEvent(data, 'topicUpdated', function (fields) {
									assert.equal(fields.data.topic, remainingTopics[topicUpdatedCalled]);
									topicUpdatedCalled++;
								});
							});
							
							// Send topicUpdated to all topics
							queue.postMessages(topics.map(function (topic) {
								return {
									event: "topicUpdated",
									topic: topic
								};
							}));
							
							// Give topicUpdated time to be erroneously called
							yield Promise.delay(100);
							eventStream.end();
							done();
						}));
					});
					
					// Send topicRemoved
					queue.postMessages({
						event: "topicDeleted",
						topic: topicToRemove
					});
				}));
			});
		})
	})
})
