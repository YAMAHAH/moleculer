/*
 * moleculer
 * Copyright (c) 2017 Ice Services (https://github.com/ice-services/moleculer)
 * MIT Licensed
 */

"use strict";

const Promise		= require("bluebird");
const _				= require("lodash");
const Transporter 	= require("./base");
const {
	PACKET_REQUEST,
	PACKET_RESPONSE,
	PACKET_UNKNOW,
	PACKET_EVENT,
	PACKET_DISCOVER,
	PACKET_INFO,
	PACKET_DISCONNECT,
	PACKET_HEARTBEAT,
	PACKET_PING,
	PACKET_PONG,
} = require("../packets");

/**
 * Transporter for AMQP
 *
 * More info: https://www.amqp.org/
 *
 * For test:
 *
 * 	 docker run -d -p 5672:5672 -p 15672:15672 --name rabbit rabbitmq:3-management
 *
 * @class AmqpTransporter
 * @extends {Transporter}
 */
class AmqpTransporter extends Transporter {

	/**
	 * Creates an instance of AmqpTransporter.
	 *
	 * @param {any} opts
	 *
	 * @memberOf AmqpTransporter
	 */
	constructor(opts) {
		if (typeof opts === "string")
			opts = { amqp: { url: opts } };

		// Number of requests a broker will handle concurrently
		if (typeof opts.amqp.prefetch !== "number")
			opts.amqp.prefetch = 1;

		// Number of milliseconds before an event expires
		if (typeof opts.amqp.eventTimeToLive !== "number")
			opts.amqp.eventTimeToLive = 5000;

		if (typeof opts.amqp.queueOptions !== "object")
			opts.amqp.queueOptions = {};

		if (typeof opts.amqp.exchangeOptions !== "object")
			opts.amqp.exchangeOptions = {};

		if (typeof opts.amqp.messageOptions !== "object")
			opts.amqp.messageOptions = {};

		if (typeof opts.amqp.consumeOptions !== "object")
			opts.amqp.consumeOptions = {};

		super(opts);

		this.hasBuiltInBalancer = true;
		this.connection = null;
		this.channel = null;
		this.bindings = [];
	}

	/**
	 * Connect to a AMQP server
	 *
	 * @memberOf AmqpTransporter
	 */
	connect() {
		return new Promise((resolve, reject) => {
			let amqp;
			try {
				amqp = require("amqplib");
			} catch(err) {
				/* istanbul ignore next */
				this.broker.fatal("The 'amqplib' package is missing. Please install it with 'npm install amqplib --save' command.", err, true);
			}

			amqp.connect(this.opts.amqp.url)
				.then(connection => {
					this.connection = connection;
					this.logger.info("AMQP is connected.");

					/* istanbul ignore next*/
					connection
						.on("error", (err) => {
							this.connected = false;
							reject(err);
							this.logger.error("AMQP connection error.");
						})
						.on("close", (err) => {
							this.connected = false;
							reject(err);
							if (!this.transit.disconnecting)
								this.logger.error("AMQP connection is closed.");
							else
								this.logger.info("AMQP connection is closed gracefully.");
						})
						.on("blocked", (reason) => {
							this.logger.warn("AMQP connection is blocked.", reason);
						})
						.on("unblocked", () => {
							this.logger.info("AMQP connection is unblocked.");
						});

					connection
						.createChannel()
						.then((channel) => {
							this.channel = channel;
							this.onConnected().then(resolve);
							this.logger.info("AMQP channel is created.");

							channel.prefetch(this.opts.amqp.prefetch);

							/* istanbul ignore next*/
							channel
								.on("close", () => {
									this.connected = false;
									this.channel = null;
									reject();
									if (!this.transit.disconnecting)
										this.logger.warn("AMQP channel is closed.");
									else
										this.logger.info("AMQP channel is closed gracefully.");
								})
								.on("error", (err) => {
									this.connected = false;
									reject(err);
									this.logger.error("AMQP channel error.", err);
								})
								.on("drain", () => {
									this.logger.info("AMQP channel is drained.");
								})
								.on("return", (msg) => {
									this.logger.warn("AMQP channel returned a message.", msg);
								});
						})
						.catch((err) => {
							/* istanbul ignore next*/
							this.logger.error("AMQP failed to create channel.");
							this.connected = false;
							reject(err);
						});
				})
				.catch((err) => {
					/* istanbul ignore next*/
					this.logger.warn("AMQP failed to connect!");
					this.connected = false;
					reject(err);
				});
		});
	}

	/**
	 * Disconnect from an AMQP server
	 *
	 * @memberOf AmqpTransporter
	 * @description Close the connection and unbind this node's queues.
	 * This prevents messages from being broadcasted to a dead node.
	 * Note: Some methods of ending a node process don't allow disconnect to fire, meaning that
	 * some dead nodes could still receive published packets.
	 * Queues and Exchanges are not be deleted since they could contain important messages.
	 */
	disconnect() {
		if (this.connection && this.channel && this.bindings) {
			return Promise.all(this.bindings.map(binding => this.channel.unbindQueue(...binding)))
				.then(() => this.channel.close())
				.then(() => this.connection.close())
				.then(() => {
					this.bindings = null;
					this.channel = null;
					this.connection = null;
				})
				.catch(err => this.logger.warn(err));
		}
	}

	/**
	 * Get assertQueue options by packet type.
	 *
	 * @param {String} packetType
	 *
	 * @memberOf AmqpTransporter
	 */
	_getQueueOptions(packetType) {
		let packetOptions;
		switch(packetType) {
			// Requests and responses don't expire.
			case PACKET_REQUEST:
			case PACKET_RESPONSE:
				packetOptions = {};
				break;
			// Packet types meant for internal use will expire after 5 seconds.
			case PACKET_DISCOVER:
			case PACKET_DISCONNECT:
			case PACKET_UNKNOW:
			case PACKET_INFO:
			case PACKET_HEARTBEAT:
			case PACKET_PING:
			case PACKET_PONG:
				packetOptions = { messageTtl: 5000, autoDelete: true };
				break;
			// Consumers can decide how long events live. Defaults to 5 seconds.
			case PACKET_EVENT:
				packetOptions = { messageTtl: this.opts.amqp.eventTimeToLive, autoDelete: true };
				break;
			// Load-balanced/grouped events
			case PACKET_EVENT + "LB":
				packetOptions = {};
				break;
		}

		return Object.assign(packetOptions, this.opts.amqp.queueOptions);
	}

	/**
	 * Build a function to handle requests.
	 *
	 * @param {String} cmd
	 * @param {Boolean} needAck
	 *
	 * @memberOf AmqpTransporter
	 */
	_consumeCB(cmd, needAck = false) {
		return (msg) => {
			const result = this.messageHandler(cmd, msg.content);

			// If a promise is returned, acknowledge the message after it has resolved.
			// This means that if a worker dies after receiving a message but before responding, the
			// message won't be lost and it can be retried.
			if(needAck) {
				if (result instanceof Promise) {
					return result
						.then(() => {
							if (this.channel)
								this.channel.ack(msg);
						})
						.catch(err => {
							this.logger.error("Message handling error.", err);
							if (this.channel)
								this.channel.nack(msg);
						});
				} else if (this.channel) {
					this.channel.ack(msg);
				}
			}
		};
	}


	/**
	 * Subscribe to a command
	 *
	 * @param {String} cmd
	 * @param {String} nodeID
	 *
	 * @memberOf AmqpTransporter
	 * @description Initialize queues and exchanges for all packet types except Request.
	 *
	 * All packets that should reach multiple nodes have a dedicated qeuue per node, and a single
	 * exchange that routes each message to all queues. These packet types will not use
	 * acknowledgements and have a set time-to-live. The time-to-live for EVENT packets can be
	 * configured in options.
	 * Examples: INFO (sometimes), DISCOVER, DISCONNECT, HEARTBEAT, PING, PONG, EVENT
	 *
	 * Other Packets are headed towards a specific node or queue. These don't need exchanges and
	 * packets of this type will not expire.
	 * Examples: REQUEST, RESPONSE
	 *
	 * RESPONSE: Each node has its own dedicated queue and acknowledgements will not be used.
	 *
	 * REQUEST: Each action has its own dedicated queue. This way if an action has multiple workers,
	 * they can all pull from the same qeuue. This allows a message to be retried by a different node
	 * if one dies before responding.
	 *
	 * Note: Queue's for REQUEST packet types are not initialized in the subscribe method because the
	 * actions themselves are not available from within the method. Instead they are intercepted from
	 * "prefix.INFO" packets because they are broadcast whenever a service is registered.
	 *
	 */
	subscribe(cmd, nodeID) {
		if (!this.channel) return;

		const topic = this.getTopicName(cmd, nodeID);

		// Some topics are specific to this node already, in these cases we don't need an exchange.
		if (nodeID != null) {
			return this.channel.assertQueue(topic, this._getQueueOptions(cmd))
				.then(() => this.channel.consume(
					topic,
					this._consumeCB(cmd),
					Object.assign({ noAck: true }, this.opts.amqp.consumeOptions)
				));

		} else {
			// Create a queue specific to this nodeID so that this node can receive broadcasted messages.
			const queueName = `${this.prefix}.${cmd}.${this.nodeID}`;

			// Save binding arguments for easy unbinding later.
			const bindingArgs = [queueName, topic, ""];
			this.bindings.push(bindingArgs);

			return Promise.all([
				this.channel.assertExchange(topic, "fanout", this.opts.amqp.exchangeOptions),
				this.channel.assertQueue(queueName, this._getQueueOptions(cmd)),
			])
				.then(() => Promise.all([
					this.channel.bindQueue(...bindingArgs),
					this.channel.consume(
						queueName,
						this._consumeCB(cmd),
						Object.assign({ noAck: true }, this.opts.amqp.consumeOptions)
					)
				]));
		}
	}

	/**
	 * Initialize queues for REQUEST packets.
	 *
	 * @memberOf AmqpTransporter
	 */
	_makeServiceSpecificSubscriptions() {
		const services = this.broker.getLocalNodeInfo().services;
		return Promise.all(services.map(service => {
			if (typeof service.actions !== "object" && typeof service.events !== "object") return Promise.resolve();

			const p = [];

			if (service.actions) {
				// Service actions queues
				p.push(Object.keys(service.actions).map(action => {
					const queue = `${this.prefix}.${PACKET_REQUEST}B.${action}`;
					return this.channel.assertQueue(queue, this._getQueueOptions(PACKET_REQUEST))
						.then(() => this.channel.consume(
							queue,
							this._consumeCB(PACKET_REQUEST, true),
							this.opts.amqp.consumeOptions
						));
				}));
			}

			if (service.events) {
				// Load-balanced/grouped events queues
				p.push(Object.keys(service.events).map(event => {
					const group = service.events[event].group || service.name;
					const queue = `${this.prefix}.${PACKET_EVENT}B.${group}.${event}`;
					return this.channel.assertQueue(queue, this._getQueueOptions(PACKET_EVENT + "LB"))
						.then(() => this.channel.consume(
							queue,
							this._consumeCB(PACKET_EVENT, true),
							this.opts.amqp.consumeOptions
						));
				}));
			}

			return Promise.all(_.compact(_.flatten(p, true)));
		}));
	}

	/**
	 * Publish a packet
	 *
	 * @param {Packet} packet
	 *
	 * @memberOf AmqpTransporter
	 * @description Send packets to their intended queues / exchanges.
	 *
	 * Reasonings documented in the subscribe method.
	 */
	publish(packet) {
		if (!this.channel) return Promise.resolve();

		let topic = this.getTopicName(packet.type, packet.target);

		if (packet.type === PACKET_EVENT && !packet.target && packet.payload.groups) {
			let groups = packet.payload.groups;
			// If the packet contains groups, we don't send the packet to
			// the targetted node, but we push them to the event group queues
			// and AMQP will load-balanced it.
			if (groups.length > 0) {
				groups.forEach(group => {
					let queue = `${this.prefix}.${PACKET_EVENT}B.${group}.${packet.payload.event}`;
					// Change the groups to this group to avoid multi handling in consumers.
					packet.payload.groups = [group];
					this.channel.sendToQueue(queue, Buffer.from(packet.serialize()), this.opts.amqp.messageOptions);
				});
				return Promise.resolve();
			}
			// If it's not contain, then it is a broadcasted event,
			// we sent it in the normal way (exchange)
		}

		const payload = Buffer.from(packet.serialize()); // amqp.node expects data to be a buffer

		if (packet.type === PACKET_REQUEST && packet.target == null) {
			topic = `${this.prefix}.${PACKET_REQUEST}B.${packet.payload.action}`;
			this.channel.sendToQueue(topic, payload, this.opts.amqp.messageOptions);
			return Promise.resolve();
		}

		if (packet.target != null) {
			this.channel.sendToQueue(topic, payload, this.opts.amqp.messageOptions);
		} else {
			this.channel.publish(topic, "", payload, this.opts.amqp.messageOptions);
		}

		// HACK: This is the best way I have found to obtain the broker's services.
		if (packet.type === PACKET_INFO && packet.target == null) {
			return this._makeServiceSpecificSubscriptions();
		}
		return Promise.resolve();
	}
}

module.exports = AmqpTransporter;
