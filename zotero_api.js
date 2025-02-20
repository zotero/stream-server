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
var cwait = require('cwait');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

var utils = require('./utils');
var log = require('./log');

const API_REQUEST_TIMEOUT = 5000;
var API_CONCURRENCY_LIMIT = 10;
var queue = new (cwait.TaskQueue)(Promise, API_CONCURRENCY_LIMIT);

//
// Zotero API interaction
//

/**
 * @param {String} apiKey
 * @param {Object} connection - A connection-like object containing 'remoteAddress'
 * @param {String} connection.remoteAddress
 * @return {String[]} - All topics accessible by the key
 */
exports.getKeyInfo = queue.wrap(async function(apiKey, connection) {
	var topics = [];
	
	// Get userID and user topic if applicable
	let response = await makeRequest(
		'keys/current?showid=1',
		{
			headers: getAPIRequestHeaders({
				apiKey,
				remoteAddress: connection.remoteAddress
			}),
		},
		connection
	);
	if (!response.ok) {
		if (response.status == 403) {
			throw new utils.WSError(403, "Invalid API key");
		}
		throw new utils.WSError(response.status, await response.text());
	}
	
	var data = await response.json();
	if (data.access && data.access.user) {
		topics.push('/users/' + data.userID);
		topics.push('/users/' + data.userID + '/publications');
	}
	
	// Get groups
	response = await makeRequest(
		'users/' + data.userID + '/groups',
		{
			headers: getAPIRequestHeaders({
				apiKey,
				remoteAddress: connection.remoteAddress
			}),
		},
		connection
	);
	if (!response.ok) {
		throw new utils.WSError(response.status, await response.text());
	}
	
	var groups = await response.json();
	for (let i = 0; i < groups.length; i++) {
		topics.push('/groups/' + groups[i].id);
	}
	
	var apiKeyID = data.id;
	if (!apiKeyID) {
		throw new Error('No API key ID in /keys/ response');
	}
	
	return {
		topics: topics,
		apiKeyID: apiKeyID
	};
});

/**
 * Check to make sure the given topic is in the list of available topics
 */
exports.checkPublicTopicAccess = queue.wrap(async function (topic, connection) {
	// TODO: Use HEAD request once main API supports it
	// TODO: Don't use /items
	var url = topic.substr(1) + '/items';
	var response = await makeRequest(
		url,
		{
			headers: getAPIRequestHeaders(connection)
		},
		connection
	);
	if (response.status == 200) {
		return true;
	}
	if (response.status == 403 || response.status == 404) {
		return false;
	}
	
	log.error("Got " + response.status + " from API for " + url, connection);
	
	// This shouldn't happen
	if (utils.isClientError(response.status)) {
		response.statusCode = 500;
	}
	throw new utils.WSError(response.status, await response.text);
});


function getAPIRequestHeaders({ apiKey, remoteAddress }) {
	var headers = JSON.parse(JSON.stringify(config.get('apiRequestHeaders')));
	headers['Zotero-API-Version'] = config.get('apiVersion');
	if (apiKey) {
		headers['Zotero-API-Key'] = apiKey;
	}
	if (remoteAddress) {
		headers['Zotero-Forwarded-For'] = remoteAddress;
	}
	return headers;
}

async function makeRequest(urlPath, options, connection) {
	var response;
	try {
		response = await fetch(
			config.get('apiURL') + urlPath,
			{
				signal: AbortSignal.timeout(API_REQUEST_TIMEOUT),
				...options
			}
		);
	}
	catch (e) {
		if (e.name === "AbortError") {
			log.error(
				`API request /${urlPath} timed out after ${API_REQUEST_TIMEOUT} ms`,
				connection
			);
		}
		else {
			log.error(e, connection);
		}
		throw new utils.WSError(500, "Server Error");
	}
	return response;
}
