#!/usr/bin/env node

// Import depencies
const spawn = require('child_process').spawn;

const path = require('path');
const fs = require('fs');
const log = require('yalm');
const airtunes = require('airtunes');
const airtunesserver = require('nodetunes');
const bonjour = require('bonjour')();
const argv = require('minimist')(process.argv.slice(2));

const net = require('net');
const http = require('http');
const Mqtt = require('mqtt');
const express = require('express');

const app = express();

// Set configuration file template
let config = {
	servername: '[AirPlay Hub]',
	webuiport: 8089,
	verbosity: 'debug',
	idletimout: 600,
	mastervolume: 50,
	zones: [],
	mqtt: true,
	mqttUrl: 'mqtt://mXXX.cloudmqtt.com:11111',
	mqttTopic: 'airplayhub',

	mqttOptions: {
		host: 'mXX.cloudmqtt.com',
		port: 11111,
		username: 'USER',
		password: 'PASS',
		clientId: 'airplayhub',
		retain: false
	}
};
let configPath = './config.json';
let mqtt;

log.info('Application starting');

// Read command line argument and see if there is a config file available - else read ./config.json
if (argv.h || argv.help) {
	console.log('usage: node-airplayhub [options]\n  options:\n	-c, --config	 Path to config file');
	process.exit();
} else {
	if (argv.c) {
		configPath = argv.c;
	}
	if (argv.config) {
		configPath = argv.config;
	}
	if (!path.isAbsolute(configPath)) {
		configPath = path.join(__dirname, configPath);
	}
}

// Try to read the config file. It it doesn't exist, create one.
try {
	config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
	log.debug('Configuration applied: \n' + JSON.stringify(config, null, 2));
} catch (e) {
	log.debug('Configuration could not be found, writing new one');
	// Not doing this - if parsing fails, this will overwrite the config file with a  default
	//	fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
}

// Set up logger
log.setLevel(config.verbosity);

// Define internal variables for speakers
const zones = config.zones;
const connectedDevices = [];
let trackinfo = {};
let idleTimer;

// Setup mqtt
if (config.mqtt) {
	log.info('MQT enabled, connecting...');
	log.debug('MQTT Options from config: ', config.mqttOptions);

	const mqttOpts = Object.assign(config.mqttOptions, {
		will: {
			topic: config.mqttTopic + '/status/connected',
			payload: '0',
			retain: true
		}
	});

	log.debug('MQTT URL: ', config.mqttUrl);
	log.debug('MQTT Options: ', mqttOpts);

	mqtt = Mqtt.connect(config.mqttUrl, mqttOpts);

	mqtt.on('connect', () => {
		log.info('mqtt connected', config.mqttUrl);

		mqttPub(config.mqttTopic + '/status/connected', '1', {
			retain: true
		});

		const topic = config.mqttTopic + '/#';
		log.info('mqtt subscribe ' + topic);

		mqtt.subscribe(topic);

		// For syncing any home assistant instances which are stateful, just list status and volume of zones for good measure
		_statusAllZones();
	});

	mqtt.on('close', () => {
		log.info('mqtt closed ' + config.mqttUrl);
	});

	mqtt.on('error', err => {
		log.error('mqtt', err.toString());
	});

	mqtt.on('offline', () => {
		log.error('mqtt offline');
	});

	mqtt.on('reconnect', () => {
		log.info('mqtt reconnect');
	});

	/*
	MQTT topics:

	-- Zone setting: enabling, disabling & volume
	airplayhub/set/Keuken/volume - message 10
	-- Must contain message of format int (from 0-100)
	airplayhub/set/Keuken/enable - message true or empty
	-- May have no message, message '1' or 'true' or message with random value. If message is false, this will be seen as speaker disable request.
	airplayhub/set/Keuken/disable
	-- Regardless of message content, will be considered as disable request.

	-- Requesting status of zone
	airplayhub/get/Keuken/volume
	-- get message: payload ignored, will always return volume
	-- Result will be sent via airplayhub/status/Keuken/volume with an int payload (0-100)

	-- Requesting status of GLOBAL volume
	airplayhub/get/GLOBAL/volume or airplayhub/set/GLOBAL/volume without message
	-- get message: payload ignored, will always return global volume
	-- Result will be sent via airplayhub/status/GLOBAL/volume with an int payload (0-100)
	-- Note that global volume scale is made so iPhone volume controls work when streaming to this airplayhub

	-- Setting GLOBAL volume
	airplayhub/set/GLOBAL/volume
	-- set message: payload required and needs to be int. (from 0-100)
	-- in both cases, result will be sent via airplayhub/status/GLOBAL/volume with an int payload

	-- Status report always via status topic
	airplayhub/status/Keuken/volume - message 10
	airplayhub/status/Living/enabled - message 1 (enabled) or 0 (disabled)
	airplayhub/status/GLOBAL/volume - message is int payload (-144, 30 to 0)
	airplayhub/status/GLOBAL/trackinfo - message is JSON with trackinfo when updated
	*/

	/*
	PRINCIPLE SHOULD BE
	1. Debug level log on full message received
	2. Perform action
	3. Info level log on action performed (so should be in the action helper function)
	4. MQTT message on action performed (also done via action helper function
	*/

	mqtt.on('message', (topic, message) => {
		message = message.toString();
		log.debug('incoming mqtt message < ', topic, message);
		const [, msgtype, speaker, command] = topic.split('/');

		// If it's a status message, ignore it
		if (_isStatusMessage(msgtype)) {
			log.debug('Status message received: <' + speaker + '> - ' + message);
			return;
		}

		// Stop processing if the msgtype is invalid, so not get or set
		if (!(_isValidMessageType(msgtype))) {
			log.info('message type invalid: ', msgtype);
			return;
		}

		// Stop processing if we don't know this speaker
		if (!(_isSpeakerKnown(speaker))) {
			log.info('unknown speaker ', speaker);
			return;
		}

		if (_isGlobalVolumeMessage(speaker)) {
			// This request is about GLOBAL volume
			log.info('Request for global volume - ignoring speaker name', speaker);

			// Setting global volume
			log.debug('MQTT message received for global volume');
			switch (msgtype) {
				// Get global volume
				case 'get':
					log.info('MQTT requesting status of global volume');
					_getMasterVolume();
					break;
					// Set global volume
				case 'set':
					log.info('MQTT requesting SETTING of global volume');
					// TODO Need to check message is int or fail gracefully
					_setMasterVolume(parseInt(message, 10));
					break;
			}
		}

		let obj;

		switch (command) {
			case 'enable':
				log.debug('Enable message received via MQTT for zone ' + speaker);
				if (message === 'false' || message === '0') {
					_stopZone(speaker);
				} else if (message === 'true' || parseInt(message, 10) > 0) {
					_startZone(speaker);
				} else {
					try {
						obj = JSON.parse(message);
						if (obj.val) {
							_startZone(speaker);
						} else {
							_stopZone(speaker);
						}
					} catch (err) {
						_startZone(speaker);
					}
				}
				break;
			case 'disable':
				log.debug('Disable message received via MQTT for zone ' + speaker);
				_stopZone(speaker);
				break;
			case 'volume':
				log.debug('Volume message received via MQTT for zone ' + speaker);
				switch (msgtype) {
					// Get speaker volume
					case 'get':
						log.debug('MQTT requesting status of speaker volume');
						_getVolume(speaker);
						break;
						// Set speaker volume
					case 'set':
						log.debug('MQTT requesting SETTING of speaker volume');
						if (isNaN(message)) {
							try {
								obj = JSON.parse(message);
								_setVolume(speaker, obj.val);
							} catch (err) {

							}
						} else {
							_setVolume(speaker, parseInt(message, 10));
						}
						break;
				}
		}
	});
}

// Debug logging on the airtunes streamer pipeline
airtunes.on('buffer', status => {
	log.debug('buffer', status);
});
let server;

// Input selector for multiroom hub
// Loopback: connect to an ALSA loopback device to stream (untested)
// Pipe: Read from pipe which is supposed to contain 16 bit 44100Hz audio
// TCP: Open a TCP socket to which a client can connect. This pipe again should contain 16 bit 44100Hz audio (untested)
// Airplay: Announce our hub as an airplay airtunesserver and as soon as someone connects, stream this data.
function startPipe() {
	// Loopback device
	if (config.loopback) {
		// Arecord
		// -f cd (16 bit little endian, 44100, stereo)
		// -D device to read from (pipe)
		server = spawn('/usr/bin/arecord', ['-f', 'cd', '-D', config.device]);

		// Connect the output of arecord to airtunes
		server.stdout.pipe(airtunes);
		log.info('Loopback connected');
		mqttPub(config.mqttTopic + '/connected', '2', {
			retain: true
		});

		mqttPub(config.mqttTopic + '/status/input', 'loopback');

		server.on('exit', () => {
			log.info('Loopback disconnected');
			mqttPub(config.mqttTopic + '/connected', '1', {
				retain: true
			});
		});
	} else if (config.inputpipe) {
		// Can also be tested with
		// sox -S -t cdr /tmp/spotify -t cdr - > /dev/null

		server = spawn('sox', ['-t', 'cdr', config.device, '-t', 'cdr', '-']);
		// Connect the output of arecord to airtunes
		server.stdout.pipe(airtunes);
		log.info('Pipe connected');
		mqttPub(config.mqttTopic + '/connected', '2', {
			retain: true
		});

		mqttPub(config.mqttTopic + '/status/input', 'pipe');

		server.on('exit', () => {
			log.info('Pipe disconnected');
			mqttPub(config.mqttTopic + '/connected', '1', {
				retain: true
			});
		});
	} else if (config.tcplisten) {
		// Tcp server
		server = net.createServer(c => {
			log.info('tcp client', c.remoteAddress + ':' + c.remotePort, 'connected');
			mqttPub(config.mqttTopic + '/connected', '2', {
				retain: true
			});

			c.on('end', () => {
				log.info('tcp client disconnected');
				c.end();
				mqttPub(config.mqttTopic + '/connected', '1', {
					retain: true
				});
			});

			c.on('error', err => {
				log.error('tcp error', err);
			});

			c.on('timeout', err => {
				log.error('tcp timeout', err);
			});

			c.pipe(airtunes, {
				end: false
			});
		});

		mqttPub(config.mqttTopic + '/status/input', 'tcp');

		server.listen(config.port, () => {
			log.info('tcp listener bound on port', config.port);
		});
	} else {
		// Airplay server
		// if someone connects to the airplay hub, stream in into the airtunes sink

		server = new airtunesserver({
			serverName: config.servername,
			verbose: false
		});

		server.on('clientConnected', stream => {
			log.info('New connection on airplayhub');
			clearTimeout(idleTimer);
			stream.pipe(airtunes);
			for (const i in zones) {
				if (zones[i].enabled) {
					log.info('Starting to stream to enabled zone ' + zones[i].name);
					connectedDevices[i] = airtunes.add(zones[i].host, {
						port: zones[i].port,
						volume: _scaleSpeakerVolume(zones[i].volume)
					});
				}
			}
		});

		// If someone disconnects to the airplay hub
		server.on('clientDisconnected', data => {
			clearTimeout(idleTimer);
			log.info('Client disconnected from airplayhub');
			if (config.idletimout > 0) {
				idleTimer = setTimeout(() => {
					airtunes.stopAll(() => {
						log.info('Stopping stream to all zones');
						for (const i in zones) {
							zones[i].enabled = false;
							log.info('Disabled zone ' + zones[i].name);
						}
						fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
					});
				}, config.idletimout * 1000);
			}
		});

		server.on('metadataChange', data => {
			log.info('Metadata changed');
			trackinfo = data;
			getArtwork(trackinfo.asar, trackinfo.asal, url => {
				if (url) {
					trackinfo.albumart = url;
				} else {
					trackinfo.albumart = '/genericart.png';
				}
			});
		});

		// This is a master change volume coming from the audio source, e.g. your iphone with Spotify. This will take that volume and translate that to a new volume level for every active speaker.
		// Master volume is between -30 & 0 (or -144 for mute) which needs to be translated into the GLOBAL volume 0-100. Per zone volume is also between 0 & 100

		/* Note on mastervolume: This is the volume used to scale the speaker volume WHEN it is playing on the airtunes server.
		speaker.volume is a configuration value kept locally. When the speaker volume is changed and the speaker is active, only then
		we will use the mastervolume to scale the playing volume in the airtunes speaker. The master volume can be setted/getted via MQTT (not yet via WEBUI) and via the device streaming to the airtunes server.
		*/

		server.on('volumeChange', data => {
			log.info('Volume change requested from sender: request master volume ' + data);
			_setMasterVolumeApple(data);
			clearTimeout(idleTimer);
		});

		log.info("Airplay hub input mode");
		mqttPub(config.mqttTopic + '/status/input', 'airplay');

		server.start();
	}
}

startPipe();

app.use('/icons', express.static(path.join(__dirname, 'root/icons'), {
	maxAge: '1y'
}));
app.use(express.static(path.join(__dirname, 'root'), {
	setHeaders: (res, path, stat) => {
		res.setHeader('Cache-Control', 'public, max-age=0');
	}
}));

// START WEBSERVER
http.createServer(app).listen(config.webuiport);

app.get('/', (req, res) => {
	res.redirect('/Index.html');
});
log.debug('Web page requested');

app.get('/startzone/:zonename', (req, res) => {
	const zonename = req.params.zonename;

	log.debug('Zone start requested for ' + zonename);

	const resp = _startZone(zonename);
	res.json(resp);
});

app.get('/stopzone/:zonename', (req, res) => {
	const zonename = req.params.zonename;

	log.debug('Zone stop requested for ' + zonename);

	const resp = _stopZone(zonename);
	res.json(resp);
});

app.get('/setvol/:zonename/:volume', (req, res) => {
	const zonename = req.params.zonename;
	const volume = req.params.volume;

	log.debug('Volume change requested for ' + zonename);

	const resp = _setVolume(zonename, volume);
	res.json(resp);
});

// GET ZONES INFORMATION FOR WEB APP
app.get('/zones', (req, res) => {
	log.debug('Zone list requested');

	const zonesNotHidden = zones.filter(z => {
		return (!z.hidden);
	});
	res.json(zonesNotHidden);
});

app.get('/hidezone/:zonename', (req, res) => {
	const zonename = req.params.zonename;

	log.debug('Zone hide requested for ' + zonename);

	const resp = _hideZone(zonename);
	res.json(resp);
});

app.get('/showzone/:zonename', (req, res) => {
	const zonename = req.params.zonename;

	log.debug('Zone show requested for ' + zonename);

	const resp = _showZone(zonename);
	res.json(resp);
});

app.get('/trackinfo', (req, res) => {
	log.debug('Trackinfo requested');
	res.json(trackinfo);
});

// ARTWORK FUNCTION
function getArtwork(artist, album, callback) {
	const url = `http://itunes.apple.com/search?term=${artist} ${album}`;

	http.get(url, res => {
		let body = '';

		res.on('data', chunk => {
			body += chunk;
		});

		res.on('end', () => {
			const albumInfo = JSON.parse(body);
			if (albumInfo.resultCount > 0) {
				callback(albumInfo.results[0].artworkUrl100.replace('100x100', '600x600'));
			} else {
				callback('/genericart.png');
			}
		});
	}).on('error', e => {
		callback('/genericart.png');
	});
}

// DISCOVERY FUNCTIONS FOR AIRPLAY DEVICES
function getIPAddress(service) {
	const addresses = service.addresses;
	// Extract right IPv4 address
	const rx = /^(?!0)(?!.*\.$)((1?\d?\d|25[0-5]|2[0-4]\d)(\.|$)){4}$/;
	for (const a in addresses) {
		// Test if we can find an ipv4 address
		if (rx.test(addresses[a]) && addresses[a].lastIndexOf('169', 0) !== 0) {
			return addresses[a];
		}
	}
}

function validateDevice(service) {
	// Extract IP address, hostname and port from mdns descriptor
	service.ip = getIPAddress(service);
	// Service.id = service.ip + ":" + service.port;
	service.name = service.name.split('@')[1];

	// Ignore self
	if (service.name === config.servername) {
		return;
	}

	// Check whether we know this zone already - if we do, do not add it again
	let zoneUnknown = true;
	let zoneChanged = false;
	for (const i in zones) {
		if (zones[i].name.toLowerCase() === service.name.toLowerCase()) {
			// Duplicate found which already existed in the config. Mind we match on the fqdn the host claims to have.
			if (service.ip !== zones[i].host) {
				zones[i].host = service.ip;
				zoneChanged = true;
			}
			if (service.port !== zones[i].port) {
				zones[i].port = service.port;
				zoneChanged = true;
			}
			zoneUnknown = false;
		}
	}

	if (zoneUnknown) {
		zones.push({
			name: service.name,
			host: service.ip,
			port: service.port,
			volume: 0,
			enabled: false,
			hidden: false
		});
		log.info('New zone added: ' + service.name);
	}
	if (zoneUnknown || zoneChanged) {
		config.zones = zones;
		fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
		log.debug('Synced running config to config file');
	}
}

// On termination signal
process.on('SIGTERM', () => {
	log.debug('Termination requested - Exiting...');
	log.debug('Writing config to ' + configPath);
	airtunes.stopAll(() => {
		log.info('Stopping stream to all zones');
		for (const i in zones) {
			zones[i].enabled = false;
			log.info('Disabled zone ' + zones[i].name);
		}
		fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
	});
	process.exit(1);
});

// On CTRL+C
process.on('SIGINT', () => {
	log.debug('User requested exit - Exiting...');
	log.debug('Writing config to ' + configPath);
	airtunes.stopAll(() => {
		log.info('Stopping stream to all zones');
		for (const i in zones) {
			zones[i].enabled = false;
			log.info('Disabled zone ' + zones[i].name);
		}
		fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
	});
	process.exit(0);
});

// Browse for all raop services
const browser = bonjour.find({
	type: 'raop'
});

browser.on('up', service => {
	log.debug('New device detected: ' + JSON.stringify(service), null, 4);
	validateDevice(service);
});

browser.on('down', service => {
	// TODO
	log.debug('Device is down: ' + JSON.stringify(service), null, 4);
});

// MQTT functions
function mqttPub(topic, payload, options) {
	log.debug('mqtt >', topic, payload);
	mqtt.publish(topic, payload, options);
}

// Assist functions

// Calculate master volume (0-100) from Apple device input volume (-144, -30 to 0)
// Input: (-144, -30 to 0)
// Output: 0-100 (0 if input is not valid)
function _parseAppleMasterVolume(vol) {
	log.debug('Calculating master volume from input Apple volume ' + vol);
	const _vol = parseInt(vol, 10);
	if (isNaN(_vol) || (!(_vol === -144 || (_vol > -30 && vol < 0)))) {
		log.debug('Requested master volume invalid ' + vol);
		return 0;
	}
	return (_vol === -144 ? 0 :
		Math.round((_vol + 30) / 0.3));
}

// Calculate master volume (0-100) from requested master volume (0 to 100)
// Input:  0-100
// Output: 0-100 (0 if input is not valid)
function _parseMasterVolume(vol) {
	log.debug('Calculating master volume from regular input volume ' + vol);
	const _vol = parseInt(vol, 10);
	if (isNaN(_vol) || (!(_vol > 0 && vol < 100))) {
		log.debug('Requested master volume invalid ' + vol);
		return 0;
	}
	return (_vol);
}

// Calculate speaker volume (0-100) from requested speaker volume and master volume (both 0 to 100)
// Input: (0-100) speaker volume request
// Output: 0-100 active speaker volume
function _scaleSpeakerVolume(vol) {
	const _scaledvol = _parseMasterVolume(vol) * config.mastervolume / 100;

	log.debug('Scaling speaker volume for requested speaker vol ' + vol + ' and master volume ' + config.mastervolume + ' to ' + _scaledvol);

	return (_scaledvol);
}

// LIST STATUS OF ALL ZONES ON MQTT CONNECT (IF MQTT ENABLED)
function _statusAllZones() {
	for (const i in zones) {
		if (config.mqtt) {
			_statusZone(zones[i].name);
			_getVolume(zones[i].name);
		}
	}
}

// SEND STATUS OF ZONES
function _statusZone(zonename) {
	let resp = {
		error: 'zone not found'
	};
	for (const i in zones) {
		if (zones[i].name.toLowerCase() === zonename.toLowerCase()) {
			const zonestatus = (zones[i].enabled === 2 ? '1' : '0');
			if (config.mqtt) {
				mqttPub(config.mqttTopic + '/status/' + zonename + '/enabled', zonestatus, {});
			}

			resp = zones[i];
		}
	}
	return resp;
}

// START A ZONE
function _startZone(zonename) {
	let resp = {
		error: 'zone not found'
	};
	for (const i in zones) {
		if (zones[i].name.toLowerCase() === zonename.toLowerCase() && zones[i].enabled === false) {
			log.debug('Starting zone ' + zonename);
			connectedDevices[i] = airtunes.add(zones[i].host, {
				port: zones[i].port,
				volume: _scaleSpeakerVolume(zones[i].volume)
			});
			zones[i].enabled = true;
			if (config.mqtt) {
				mqttPub(config.mqttTopic + '/status/' + zonename + '/enabled', '1', {});
			}

			resp = zones[i];
		} else if (zones[i].name.toLowerCase() === zonename.toLowerCase() && zones[i].enabled === true) {
			// TODO publish status on this zone. It's already enabled

                        log.debug('Zone already enabled - ' + zonename);
                        if (config.mqtt) {
                                mqttPub(config.mqttTopic + '/status/' + zonename + '/enabled', '1', {});
                        }

    		}
	}
	fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
	return resp;
}

// STOP A ZONE
function _stopZone(zonename) {
	let resp = {
		error: 'zone not found'
	};
	for (const i in zones) {
		if (zones[i].name.toLowerCase() === zonename.toLowerCase() && zones[i].enabled === true) {
			zones[i].enabled = false;
			if (connectedDevices[i]) {
				log.debug('Stopping zone ' + zonename);
				connectedDevices[i].stop();
				if (config.mqtt) {
					mqttPub(config.mqttTopic + '/status/' + zonename + '/enabled', '0', {});
				}
			}
			resp = zones[i];
		} else if (zones[i].name.toLowerCase() === zonename.toLowerCase() && zones[i].enabled === false) {
                        // TODO publish status on this zone. It's already disabled

                        log.debug('Zone already disabled - ' + zonename);
                        if (config.mqtt) {
                                mqttPub(config.mqttTopic + '/status/' + zonename + '/enabled', '0', {});
                        }

                }
	}
	fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
	return resp;
}

// SHOW A ZONE - ONLY USED IN WEBUI SO NO OUTPUT TO MQTT
function _showZone(zonename) {
	let resp = {
		error: 'zone not found'
	};
	for (const i in zones) {
		if (zones[i].name.toLowerCase() === zonename.toLowerCase()) {
			zones[i].hidden = false;
			resp = zones[i];
		}
	}
	fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
	return resp;
}

// HIDE A ZONE - ONLY USED IN WEBUI SO NO OUTPUT TO MQTT
function _hideZone(zonename) {
	let resp = {
		error: 'zone not found'
	};
	for (const i in zones) {
		if (zones[i].name.toLowerCase() === zonename.toLowerCase()) {
			zones[i].hidden = true;
			resp = zones[i];
		}
	}
	fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
	return resp;
}

// SET VOLUME (with master volume)
function _setVolume(zonename, volume) {
	let resp = {
		error: 'zone not found'
	};
	log.info('Set volume requested for speaker ' + zonename + ' - set speaker volume to ' + volume);
	for (const i in zones) {
		if (zones[i].name.toLowerCase() == zonename.toLowerCase()) {
			// Setting configured per-speaker volume
			zones[i].volume = volume;
			if (connectedDevices[i]) {
				// And adjusting the mastervolume of this speaker if it's active on the airtunes server
				log.info('Speaker active - scaling volume request with mastervolume to ' + _scaleSpeakerVolume(volume) + ' for ' + zonename);
				connectedDevices[i].setVolume(_scaleSpeakerVolume(volume));
				if (config.mqtt) {
					mqttPub(config.mqttTopic + '/status/' + zonename + '/volume', volume.toString(), {});
				}
			} else {
				log.info('Zone ' + zonename + ' not found - ignoring request');
			}
			resp = zones[i];
		}
	}
	config.zones = zones;
	fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
	return volume;
}

function _getVolume(speaker) {
	let resp = {
		error: 'zone not found'
	};
	log.info('Get volume called for ' + speaker);
	for (const i in zones) {
		if (zones[i].name.toLowerCase() === speaker.toLowerCase() && speaker !== 'GLOBAL') {
			log.info('Zone get volume called for ' + speaker);
			const zonevol = zones[i].volume;
			if (config.mqtt) {
				mqttPub(config.mqttTopic + '/status/' + speaker + '/volume', zonevol.toString(), {});
			}
			} else {
				log.info('Zone ' + speaker + ' not found - ignoring request');
			}
			resp = zones[i];
			return zonevol;
		}
	}
}

// If we change the master volume while speakers are replaying, we need to re-scale all the enabled zones.
// Input: None
// Output: None
// Action: Re-sets all speaker volumes based on requested speaker volume and the master volume
function _masterRescale() {
	// For all active speakers
	for (const i in zones) {
		if (zones[i].enabled) {
			// Re-scale the existing per-speaker volume with the new master volume

			log.info('Rescale volume for zone ' + zones[i].name + ' to ' + _scaleSpeakerVolume(zones[i].volume));
			connectedDevices[i].setVolume(_scaleSpeakerVolume(zones[i].volume));
			if (config.mqtt) {
				// MQTT publish all new volumes to sync home assistant
				_getVolume(zones[i].name);
			}
		}
	}
	// MQTT publish new master volume for good measure
	_getMasterVolume();
}

// Input:  volume is -144 or (-30 to zero)
// output: config.mastervolume between 0 & 100
function _setMasterVolumeApple(volume) {

	const _volume = (parseInt(volume, 10));
	log.debug('Apple original master volume requested to change to ' + _volume.toString());
	const _volumerescaled = _parseAppleMasterVolume(_volume);
	log.debug('Changing master volume to ' + _volumerescaled.toString());

	config.mastervolume = _volumerescaled; // 0 to 100

	if (config.mqtt) {
		log.debug('Setting master volume to ' + config.mastervolume.toString());
		mqttPub(config.mqttTopic + '/status/GLOBAL/volume', config.mastervolume.toString(), {});
	}
	_masterRescale();
}

// Input:  volume is 0 - 100
// output: config.mastervolume between 0 & 100
function _setMasterVolume(volume) {

	config.mastervolume = _parseMasterVolume(volume);

	if (config.mqtt) {
		log.debug('Setting master volume to ' + config.mastervolume.toString());
		mqttPub(config.mqttTopic + '/status/GLOBAL/volume', config.mastervolume.toString(), {});
	}
	_masterRescale();
}

// Output: Publish  config.mastervolume between 0 & 100
function _getMasterVolume() {
	if (config.mqtt) {
		log.debug('Publishing master volume ' + config.mastervolume.toString());
		mqttPub(config.mqttTopic + '/status/GLOBAL/volume', config.mastervolume.toString(), {});
	}
}

// Speaker is a string, the speakername
function _isSpeakerKnown(speaker) {
	// Check whether this message is about GLOBAL or a specific speaker which we know about
	for (const i in zones) {
		if (zones[i].name.toLowerCase() === speaker.toLowerCase() || speaker.toLowerCase() === 'GLOBAL'.toLowerCase()) {
			// This is a known speaker - continue parsing
			return true;
		}
	}

	return false;
}

// Msgtype is a string: get, set or status
function _isStatusMessage(msgtype) {
	if (msgtype.toLowerCase() === 'status') {
		return true;
	}
	return false;
}

// Speaker is a string, the speakername
function _isGlobalVolumeMessage(speaker) {
	if (speaker.toLowerCase() === 'GLOBAL'.toLowerCase()) {
		// This request is about GLOBAL volume
		return true;
	}
	return false;
}

function _isValidMessageType(msgtype) {
	if (['get', 'set', 'status'].indexOf(msgtype) >= 0) {
		// The msgtype is good
		return true;
	}
	return false;
}

browser.start();
