var os = require("os");

// Default config
var config = {
	dev: false,
	logLevel: 'info',
	hostname: os.hostname().split('.')[0],
	httpPort: 8080,
	proxyProtocol: false,
	https: false,
	statusInterval: 10,
	keepaliveInterval: 25,
	retryTime: 10,
	shutdownDelay: 100,
	redis: {
		host: '',
		prefix: ''
	},
	apiURL: 'https://api.zotero.org/',
	apiVersion: 3,
	apiRequestHeaders: {},
	longStackTraces: false,
	continuedDelay: 30 * 1000,
	statsD: {
		host: ''
	}
};

module.exports = config;
