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
var randomstring = require('randomstring');

var AWS = require('aws-sdk');
AWS.config.update({ region: config.get('awsRegion') });
var SNS = new AWS.SNS({ apiVersion: '2010-03-31' });
var SQS = new AWS.SQS({ apiVersion: '2012-11-05' });
Promise.promisifyAll(Object.getPrototypeOf(SNS));
Promise.promisifyAll(Object.getPrototypeOf(SQS));

var log = require('./log');

/**
 * Create SQS queue and subscribe it to an SNS topic
 */
exports.create = Promise.coroutine(function* () {
	if (!config.get('snsTopic')) {
		throw new Error("config.snsTopic is not set");
	}
	
	log.info("Creating SQS queue and SNS subscription");
	
	var queueName = config.get('sqsQueuePrefix')
		+ "-" + config.get('hostname')
		+ "-" + randomstring.generate(4);
	// Determine queue ARN from the SNS topic. This assumes that the SQS queue and SNS topic
	// are in the same account and region, but otherwise we have to make a separate request
	// to set the policy after creating the queue, and the permissions may not take effect
	// immediately (though they probably do in practice).
	var queueARN = config.get('snsTopic').replace(':sns:', ':sqs:').replace(/:[^:]+$/, ":" + queueName);
	var policy = JSON.stringify({
		"Version": "2012-10-17",
		"Statement": [
			{
				"Effect": "Allow",
				"Principal": "*",
				"Action": "sqs:SendMessage",
				"Resource": queueARN,
				"Condition": {
					"ArnEquals": {
						"aws:SourceArn": config.get('snsTopic')
					}
				}
			}
		]
	});
	
	var queueURL = (yield SQS.createQueueAsync({
		QueueName: queueName,
		Attributes: {
			ReceiveMessageWaitTimeSeconds: "20",
			Policy: policy
		}
	})).QueueUrl;
	
	log.info("Created queue " + queueName);
	
	var queueARN = (yield SQS.getQueueAttributesAsync({
		QueueUrl: queueURL,
		AttributeNames: ['QueueArn']
	})).Attributes.QueueArn;
	
	log.debug("Queue ARN: " + queueARN);
	
	var subscriptionARN = (yield SNS.subscribeAsync({
		TopicArn: config.get('snsTopic'),
		Protocol: 'sqs',
		Endpoint: queueARN
	})).SubscriptionArn;
	
	log.debug("Subscription ARN: " + subscriptionARN);
	
	return {
		queueURL: queueURL,
		subscriptionARN: subscriptionARN
	};
});

exports.receiveMessages = function (queueURL) {
	return SQS.receiveMessageAsync({
		QueueUrl: queueURL,
		MaxNumberOfMessages: 10
	}).get('Messages');
};

exports.deleteMessages = Promise.coroutine(function* (queueURL, messages) {
	var numSuccessful = 0;
	var numFailed = 0;
	var max = 10;
	for (let i = 0, num = messages.length; i < num; i += max) {
		let chunk = messages.slice(i, i + max);
		let result = yield SQS.deleteMessageBatchAsync({
			QueueUrl: queueURL,
			Entries: chunk.map(function (msg) {
				return {
					Id: msg.MessageId,
					ReceiptHandle: msg.ReceiptHandle
				}
			})
		});
		numSuccessful += result.Successful.length;
		if (result.Failed.length) {
			numFailed += result.Failed.length;
			result.Failed.forEach(function (e) {
				log.warn(JSON.stringify(e));
			})
		}
	}
	
	return {
		successful: numSuccessful,
		failed: numFailed
	}
});

exports.terminate = Promise.coroutine(function* (queueData) {
	log.info("Deleting subscription and queue");
	
	return Promise.all([
		SNS.unsubscribeAsync({
			SubscriptionArn: queueData.subscriptionARN
		})
		.then(function () {
			log.info("Deleted subscription " + queueData.subscriptionARN);
		})
		.catch(function (e) {
			log.error("Error deleting subscription: " + e.stack);
		}),
		
		SQS.deleteQueueAsync({
			QueueUrl: queueData.queueURL
		})
		.then(function () {
			log.info("Deleted queue " + queueData.queueURL);
		})
		.catch(function (e) {
			log.error("Error deleting queue: " + e.stack);
		})
	]);
});
