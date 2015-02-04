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
var request = Promise.promisify(require('request'));

var utils = require('./utils');

//
// Zotero API interaction
//

/**
 * @param {String} apiKey
 * @return {String[]} - All topics accessible by the key
 */
exports.getAllKeyTopics = Promise.coroutine(function* (apiKey) {
	var topics = [];
	
	// Get userID and user topic if applicable
	var options = {
		url: config.get('apiURL') + 'keys/' + apiKey,
		headers: getAPIRequestHeaders()
	}
	try {
		var body = yield request(options).spread(function (response, body) {
			if (response.statusCode != 200) {
				throw response;
			}
			return body;
		});
	}
	catch (e) {
		if (e.statusCode == 404) {
			throw new utils.HTTPError(403, "Invalid API key");
		}
		else if (e.statusCode) {
			throw new utils.HTTPError(e.statusCode, e.body);
		}
		else {
			throw new Error("Error getting key permissions: " + e);
		}
	}
	
	var data = JSON.parse(body);
	if (data.access && data.access.user) {
		topics.push('/users/' + data.userID);
	}
	
	// Get groups
	var options = {
		url: config.get('apiURL') + 'users/' + data.userID + '/groups',
		headers: getAPIRequestHeaders(apiKey)
	}
	try {
		var body = yield request(options).get(1);
	}
	catch (e) {
		if (e.statusCode) {
			throw new utils.HTTPError(e.statusCode, e.body);
		}
		else {
			throw new Error("Error getting key groups: " + e);
		}
	}
	
	var groups = JSON.parse(body);
	for (let i = 0; i < groups.length; i++) {
		topics.push('/groups/' + groups[i].id);
	}
	return topics;
});


/**
 * Check to make sure the given topic is in the list of available topics
 */
exports.checkTopicAccess = Promise.coroutine(function* (availableTopics, topic) {
	return availableTopics.indexOf(topic) != -1;
});


function getAPIRequestHeaders(apiKey) {
	var headers = JSON.parse(JSON.stringify(config.get('apiRequestHeaders')));
	headers['Zotero-API-Version'] = config.get('apiVersion');
	if (apiKey) {
		headers['Zotero-API-Key'] = apiKey;
	}
	return headers;
}
