var os = require("os");

// Default config
var config = {
	dev: false,
	debug: false,
	hostname: os.hostname().split('.')[0],
	httpPort: 8080,
	proxyProtocol: false,
	https: false,
	statusInterval: 10,
	keepaliveInterval: 25,
	retryTime: 10,
	awsRegion: 'us-east-1',
	sqsQueuePrefix: "library-updates-",
	apiURL: 'https://api.zotero.org/',
	apiVersion: 3,
	apiRequestHeaders: {}
};

module.exports = config;
