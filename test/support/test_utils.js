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
var Promise = require('bluebird');
var requestAsync = Promise.promisify(require('request'));
var randomstring = require('randomstring');

module.exports = {
	baseURL: 'http://127.0.0.1:' + config.get('httpPort') + '/',
	
	/**
	 * Parse an SSE and run a function if it matches the given event name
	 *
	 * @param {String} msg
	 * @param {String} event - Value of event: field. If null, all events will match.
	 * @param {Function} func - Function to run for matching events. Function will be passed
	 *                          an object with fields from the event (e.g., .event, .data).
	 *                          data: lines are automatically concatenated and parsed as JSON.
	 */
	onEvent: function (msg, event, func) {
		try {
			var lines = msg.toString().trim().split(/\n/);
			var fields = {};
			var dataStarted = false;
			var dataStopped = false;
			
			// Parse lines
			for (let i = 0; i < lines.length; i++) {
				let line = lines[i];
				let parts = line.match(/^([^:]+): ?(.+)/);
				if (!parts) {
					throw new Error("Invalid line '" + line + "' in event data");
				}
				let field = parts[1];
				let content = parts[2];
				
				if (field == 'data') {
					// Make sure there's only one block of data: lines (which technically isn't
					// required by the spec but shouldn't happen)
					if (dataStopped) {
						throw new Error("More than one data: block found in event");
					}
					dataStarted = true;
					if (!fields.data) {
						fields.data = '';
					}
					fields.data += content;
				}
				else {
					if (field in fields) {
						throw new Error("Field '" + field + "' appeared more than once in event");
					}
					
					if (dataStarted) {
						dataStopped = true;
					}
				}
				fields[field] = content;
			}
			if (fields.data) {
				fields.data = JSON.parse(fields.data);
			}
			if (event && fields.event != event) {
				return;
			}
			
			func(fields);
		}
		catch (e) {
			console.log(e);
			throw e;
		}
	},
	
	makeAPIKey: function () {
		return randomstring.generate(24);
	},
	
	addSubscriptions: function (connectionID, apiKey, topics) {
		return requestAsync({
			method: 'post',
			url: this.baseURL + "connections/" + connectionID,
			body: {
				subscriptions: [{
					apiKey: apiKey,
					topics: topics
				}]
			},
			json: true
		}).get(0);
	},
	
	addSubscriptionsByKeys: function (connectionID, apiKeys) {
		return requestAsync({
			method: 'post',
			url: this.baseURL + "connections/" + connectionID,
			body: {
				subscriptions: apiKeys.map(function (apiKey) {
					return {
						apiKey: apiKey
					};
				})
			},
			json: true
		}).get(0);
	}
}
