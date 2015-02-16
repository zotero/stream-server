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
	awsRegion: 'us-east-1',
	snsTopic: "",
	sqsQueuePrefix: "StreamEvents",
	apiURL: 'https://api.zotero.org/',
	apiVersion: 3,
	apiRequestHeaders: {},
	longStackTraces: false
};

module.exports = config;
