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
		
		if (message.apiKeyID) {
			name = message.apiKeyID;
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
