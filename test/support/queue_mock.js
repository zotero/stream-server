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

var Promise = require('bluebird');
var randomstring = require('randomstring');
var utils = require('../../utils');

module.exports = {
	_messages: {},
	_triggers: {},
	
	create: Promise.coroutine(function* () {
		var queueURL = randomstring.generate(10);
		this._messages[queueURL] = {};
		return {
			queueURL: queueURL
		}
	}),
	
	receiveMessages: function (queueURL) {
		var queue = this._messages[queueURL];
		var defer = Promise.defer();
		this._triggers[queueURL] = function () {
			var messages = [];
			var numReceived = 0;
			for (let id in queue) {
				let message = queue[id];
				if (message.receiptHandle
						&& message.lastReceived > ((new Date).getTime() - 30000)) {
					continue;
				}
				message.receiptHandle = randomstring.generate(10);
				message.lastReceived = new Date;
				messages.push({
					MessageId: id,
					ReceiptHandle: message.receiptHandle,
					Body: message.body
				});
				numReceived++;
				
				if (numReceived == 10) {
					break;
				}
			}
			defer.resolve(messages);
		};
		return defer.promise.timeout(5000);
	},
	
	deleteMessages: Promise.coroutine(function* (queueURL, messages) {
		var results = {
			successful: 0,
			failed: 0
		}
		var queue = this._messages[queueURL];
		for (let i = 0; i < messages.length; i++) {
			let message = messages[i];
			let id = message.MessageId;
			let receiptHandle = message.ReceiptHandle;
			
			if (queue[id] && queue[id].receiptHandle == receiptHandle) {
				delete queue[id];
				results.successful++;
			}
			else {
				results.failed++;
			}
		}
		return results;
	}),
	
	terminate: Promise.coroutine(function* (queueData) {
		delete this._messages[queueData.queueURL];
		delete this._triggers[queueData.queueURL];
	}),
	
	//
	// For testing
	//
	postMessages: function (messages) {
		if (!Array.isArray(messages)) {
			messages = [messages];
		}
		for (let i = 0; i < messages.length; i++) {
			let id = randomstring.generate(10);
			let message = {
				id: id,
				body: JSON.stringify({
					Message: JSON.stringify(messages[i])
				})
			};
			for (let queueURL in this._messages) {
				//console.log("Posting message: " + JSON.stringify(message));
				this._messages[queueURL][id] = message;
			}
		}
		for (let i in this._triggers) {
			let trigger = this._triggers[i];
			setTimeout(function () {
				trigger();
			}.bind(this));
		}
	}
}
