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

var request = require('request');
var config = require('config');
var querystring = require('querystring');

var baseURL = 'http://127.0.0.1:' + config.get('httpPort') + '/';

/**
 * Wrapper around an event stream HTTP request
 */
function EventStream(params, cb) {
	var qs = querystring.stringify(params);
	this._request = request({
		url: baseURL + (qs ? '?' + qs : ''),
		headers: {
			accept: "text/event-stream"
		}
	}, cb);
	this._request.on('response', function (response) {
		this._response = response;
		if (this._responseListener) {
			this._responseListener(response);
		}
	}.bind(this));
}

EventStream.prototype.on = function () {
	if (arguments[0] == 'response') {
		this._responseListener = arguments[1];
	}
	else {
		this._request.on.apply(this._request, arguments);
	}
}

EventStream.prototype.end = function () {
	this._response.emit('end');
}

module.exports = EventStream;
