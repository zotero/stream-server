/*
 ***** BEGIN LICENSE BLOCK *****
 
 Copyright © 2017 Zotero
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

var Channel = function (options) {
	_listeners = [];
	_names = [];
};

module.exports = Channel;

Channel.prototype.subscribe = function (names) {
	if (!Array.isArray(names)) {
		names = [names];
	}
	
	for (var i = 0; i < names.length; i++) {
		var name = names[i];
		if (_names.indexOf(name) < 0) {
			_names.push(name);
		}
	}
};

Channel.prototype.unsubscribe = function (names) {
	if (!Array.isArray(names)) {
		names = [names];
	}
	
	for (var i = 0; i < names.length; i++) {
		var name = names[i];
		var n = _names.indexOf(name);
		if (n >= 0) {
			_names.splice(n, 1);
		}
	}
};

Channel.prototype.on = function (event, callback) {
	if (event == 'message') {
		_listeners.push(callback);
	}
};

Channel.prototype.postMessages = function (messages) {
	if (!Array.isArray(messages)) {
		messages = [messages];
	}
	
	for (let i = 0; i < messages.length; i++) {
		let message = messages[i];
		
		let name;
		
		if (message.apiKey) {
			name = message.apiKey;
		} else {
			name = message.topic;
		}
		
		if (_names.indexOf(name) >= 0) {
			for (let j = 0; j < _listeners.length; j++) {
				let listener = _listeners[j];
				listener(name, JSON.stringify(message));
			}
		}
	}
};
