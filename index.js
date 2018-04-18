#!/usr/bin/env node

// Import depencies
var path = require('path');
var fs = require('fs');
const express = require('express');
const Mqtt = require('mqtt');
const log = require('yalm');
const airtunes = require('airtunes');
const airtunesserver = require('nodetunes');
const net = require('net');
const bonjour = require('bonjour')();
var argv = require('minimist')(process.argv.slice(2));
var app = express();
var http = require('http');
const spawn = require('child_process').spawn;

// Set configuration file template
var config = {
    "servername": "[AirPlay Hub]",
    "webuiport": 8089,
    "verbosity": "debug",
    "idletimout": 600,
    "mastervolume": 50,
    "zones": [],
    "mqtt": true,
    "mqttUrl": "mqtt://mXXX.cloudmqtt.com:11111",
    "mqttTopic": "airplayhub",

    "mqttOptions": {
        "host": "mXX.cloudmqtt.com",
        "port": 11111,
        "username": "USER",
        "password": "PASS",
        "clientId": "airplayhub",
        "retain": false
    }
};
var configPath = './config.json';
var mqtt;

log.info('Application starting');

// Read command line argument and see if there is a config file available - else read ./config.json
if (argv.h || argv.help) {
    console.log('usage: node-airplayhub [options]\n  options:\n    -c, --config     Path to config file');
    process.exit();
} else {
    if (argv.c) configPath = argv.c;
    if (argv.config) configPath = argv.config;
    if (!path.isAbsolute(configPath)) configPath = path.join(__dirname, configPath);
}

// Try to read the config file. It it doesn't exist, create one.
try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    log.debug('Configuration applied: \n' + JSON.stringify(config, null, 2));

} catch (e) {
    log.debug('Configuration could not be found, writing new one');
    // Not doing this - if parsing fails, this will overwrite the config file with a  default
    //    fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
}

// Set up logger
log.setLevel(config.verbosity);

// define internal variables for speakers
var zones = config.zones;
var connectedDevices = [];
var trackinfo = {};
var idleTimer;

// setup mqtt
if (config.mqtt) {

    log.info('MQT enabled, connecting...');
    log.debug("MQTT Options from config: ", config.mqttOptions);

    var mqttOpts = Object.assign(config.mqttOptions, {
        will: {
            topic: config.mqttTopic + '/status/connected',
            payload: '0',
            retain: true
        }
    });

    log.debug("MQTT URL: ", config.mqttUrl);
    log.debug("MQTT Options: ", mqttOpts);


    mqtt = Mqtt.connect(config.mqttUrl, mqttOpts);

    mqtt.on('connect', () => {
        log.info('mqtt connected', config.mqttUrl);

        mqttPub(config.mqttTopic + '/status/connected', '1', {
            retain: true
        });

        var topic = config.mqttTopic + '/#';
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
        var [, msgtype, speaker, command] = topic.split('/');

        // If it's a status message, ignore it
        if (_isStatusMessage(msgtype)) {
            log.debug("Status message received: <" + speaker + "> - " + message);
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

            // setting global volume
            log.debug("MQTT message received for global volume");
            switch (msgtype) {
                // get global volume
                case 'get':
                    log.info("MQTT requesting status of global volume");
                    _getMasterVolume();
                    break;
                // set global volume
                case 'set':
                    log.info("MQTT requesting SETTING of global volume");
                    // TODO Need to check message is int or fail gracefully
                    _setMasterVolume(parseInt(message, 10));
                    break;
            }
        }

        let obj;

        switch (command) {
            case 'enable':
                log.debug("Enable message received via MQTT for zone " + speaker);
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
                log.debug("Disable message received via MQTT for zone " + speaker);
                _stopZone(speaker);
                break;
            case 'volume':
                log.debug("Volume message received via MQTT for zone " + speaker);
                switch (msgtype) {
                    // get speaker volume
                    case 'get':
                        log.debug("MQTT requesting status of speaker volume");
                        _getVolume(speaker);
                    	  break;
                    // set speaker volume
                    case 'set':
                        log.debug("MQTT requesting SETTING of speaker volume");
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

// debug logging on the airtunes streamer pipeline
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
    // loopback device
    if (config.loopback) {
        // arecord
        // -f cd (16 bit little endian, 44100, stereo) 
        // -D device to read from (pipe)
        server = spawn('/usr/bin/arecord', ['-f', 'cd', '-D', config.device]);

        // connect the output of arecord to airtunes
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
    }



   // pipe
    else if (config.inputpipe) {
	// can also be tested with
        // sox -S -t cdr /tmp/spotify -t cdr - > /dev/null

        server = spawn('sox', ['-t', 'cdr', config.device, '-t', 'cdr', '-']);
        // connect the output of arecord to airtunes
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

    }


    else if (config.tcplisten) {
        // tcp server
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
    } 
    else {
        // airplay server
        // if someone connects to the airplay hub, stream in into the airtunes sink
		
		server = new airtunesserver({
			serverName: config.servername,
			verbose: false
		});

        server.on('clientConnected', function(stream) {
            log.info("New connection on airplayhub");
            clearTimeout(idleTimer);
            stream.pipe(airtunes);
            for (var i in zones) {
                if (zones[i].enabled) {
                    log.info("Starting to stream to enabled zone " + zones[i].name);
                    connectedDevices[i] = airtunes.add(zones[i].host, {
                        port: zones[i].port,
                        volume: scaleSpeakerVolume(zones[i].volume)
                    });
                }
            }
        });

        // if someone disconnects to the airplay hub
        server.on('clientDisconnected', (data) => {
            clearTimeout(idleTimer);
            log.info("Client disconnected from airplayhub");
            if (config.idletimout > 0) {
                idleTimer = setTimeout(() => {
                    airtunes.stopAll(() => {
                        log.info("Stopping stream to all zones");
                        for (var i in zones) {
                            zones[i].enabled = false;
                            log.info("Disabled zone " + zones[i].name);
                        }
                        fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
                    });
                }, config.idletimout * 1000);
            }
        });


        server.on('metadataChange', (data) => {
            log.info("Metadata changed");
            trackinfo = data;
            getArtwork(trackinfo.asar, trackinfo.asal, (url) => {
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


        server.on('volumeChange', (data) => {
            log.info("Volume change requested from sender: request master volume " + data);
            _setMasterVolumeApple(data);
            clearTimeout(idleTimer);
        });

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
log.debug("Web page requested");


app.get('/startzone/:zonename', function (req, res) {
    var zonename = req.params.zonename;

    log.debug("Zone start requested for " + zonename);
    
    var resp = _startZone(zonename);
    res.json(resp);
});


app.get('/stopzone/:zonename', function (req, res) {
    var zonename = req.params.zonename;

    log.debug("Zone stop requested for " + zonename);

    var resp = _stopZone(zonename);
    res.json(resp);
});


app.get('/setvol/:zonename/:volume', function (req, res) {
    var zonename = req.params.zonename;
    var volume = req.params.volume;

    log.debug("Volume change requested for " + zonename);

    var resp = _setVolume(zonename, volume);
    res.json(resp);
});


// GET ZONES INFORMATION FOR WEB APP
app.get('/zones', function (req, res) {
    log.debug("Zone list requested");

    var zonesNotHidden = zones.filter(function (z) {
        return (!z.hidden);
    });
    res.json(zonesNotHidden);
});


app.get('/hidezone/:zonename', function (req, res) {
    var zonename = req.params.zonename;

    log.debug("Zone hide requested for " + zonename);

    var resp = _hideZone(zonename);
    res.json(resp);
});


app.get('/showzone/:zonename', function (req, res) {
    var zonename = req.params.zonename;

    log.debug("Zone show requested for " + zonename);

    var resp = _showZone(zonename);
    res.json(resp);
});

app.get('/trackinfo', function (req, res) {
    log.debug("Trackinfo requested");
    res.json(trackinfo);
});


// ARTWORK FUNCTION
function getArtwork(artist, album, callback) {
    var url = `http://itunes.apple.com/search?term=${artist} ${album}`;

    http.get(url, function (res) {
        var body = '';

        res.on('data', function (chunk) {
            body += chunk;
        });

        res.on('end', function () {
            var albumInfo = JSON.parse(body);
            if (albumInfo.resultCount > 0) {
                callback(albumInfo.results[0].artworkUrl100.replace('100x100', '600x600'));
            } else {
                callback('/genericart.png');
            }
        });
    }).on('error', function (e) {
        callback('/genericart.png');
    });
}


// DISCOVERY FUNCTIONS FOR AIRPLAY DEVICES
function getIPAddress(service) {

    var addresses = service.addresses;
    // Extract right IPv4 address
    var rx = /^(?!0)(?!.*\.$)((1?\d?\d|25[0-5]|2[0-4]\d)(\.|$)){4}$/;
    for (var a in addresses) {
        // Test if we can find an ipv4 address
        if (rx.test(addresses[a]) && addresses[a].lastIndexOf('169', 0) !== 0) {
            return addresses[a];
        }
    }
}

function validateDevice(service) {

    // Extract IP address, hostname and port from mdns descriptor
    service.ip = getIPAddress(service);
    //service.id = service.ip + ":" + service.port;
    service.name = service.name.split('@')[1];

    // Ignore self
    if (service.name == config.servername) return;

    // Check whether we know this zone already - if we do, do not add it again
    var zoneUnknown = true;
    var zoneChanged = false;
    for (var i in zones) {
        if (zones[i].name.toLowerCase() == service.name.toLowerCase()) {
            // Duplicate found which already existed in the config. Mind we match on the fqdn the host claims to have.
            if (service.ip != zones[i].host) {
                zones[i].host = service.ip;
                zoneChanged = true;
            }
            if (service.port != zones[i].port) {
                zones[i].port = service.port;
                zoneChanged = true;
            }
            zoneUnknown = false;
        }
    }

    if (zoneUnknown) {
        zones.push({
            "name": service.name,
            "host": service.ip,
            "port": service.port,
            "volume": 0,
            "enabled": false,
            "hidden": false
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
process.on('SIGTERM', function () {
    log.debug("Termination requested - Exiting...");
    log.debug("Writing config to " + configPath);
    airtunes.stopAll(() => {
        log.info("Stopping stream to all zones");
        for (var i in zones) {
            zones[i].enabled = false;
            log.info("Disabled zone " + zones[i].name);
        }
        fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
    });
    process.exit(1);
});

// On CTRL+C
process.on('SIGINT', function () {
    log.debug("User requested exit - Exiting...");
    log.debug("Writing config to " + configPath);
    airtunes.stopAll(() => {
        log.info("Stopping stream to all zones");
        for (var i in zones) {
            zones[i].enabled = false;
            log.info("Disabled zone " + zones[i].name);
        }
        fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
    });
    process.exit(0);
});


// browse for all raop services
var browser = bonjour.find({
    type: 'raop'
});

browser.on('up', function (service) {
    log.debug("New device detected: " + JSON.stringify(service), null, 4);
    validateDevice(service);
});

browser.on('down', function (service) {
    // TODO
    log.debug("Device is down: " + JSON.stringify(service), null, 4);

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
function parseAppleMasterVolume(vol) {
    log.debug("Calculating master volume from input Apple volume " + vol);
    var _vol = parseInt(vol, 10);
    if ( isNaN(_vol) || (! (_vol == -144 || (_vol > -30 && vol < 0))) ) { 
	    log.debug("Requested master volume invalid " + vol);
	    return 0;
    }
    return (_vol == -144 ? 0 :
        Math.round( (_vol + 30) / 0.3));
}

// Calculate master volume (0-100) from requested master volume (0 to 100)
// Input:  0-100
// Output: 0-100 (0 if input is not valid)
function parseMasterVolume(vol) {
    log.debug("Calculating master volume from regular input volume " + vol);
    var _vol = parseInt(vol, 10);
    if ( isNaN(_vol) || (!(_vol > 0 && vol < 100)) ) { 
	    log.debug("Requested master volume invalid " + vol);
	    return 0;
    }
    return (_vol);
}

// Calculate speaker volume (0-100) from requested speaker volume and master volume (both 0 to 100)
// Input: (0-100) speaker volume request
// Output: 0-100 active speaker volume
function scaleSpeakerVolume(vol) {
    var _scaledvol = parseMasterVolume(vol)*config.mastervolume/100;

    log.debug("Scaling speaker volume for requested speaker vol " + vol + " and master volume "+config.mastervolume + " to "+ _scaledvol);

    return (_scaledvol);
}



// LIST STATUS OF ALL ZONES ON MQTT CONNECT (IF MQTT ENABLED)
function _statusAllZones() {
    for (var i in zones) {
            if (config.mqtt) {
                  _statusZone(zones[i].name);
                  _getVolume(zones[i].name);
                
            }
    }
}


// SEND STATUS OF ZONES
function _statusZone(zonename) {
    var resp = {
        error: "zone not found"
    };
    for (var i in zones) {
        if (zones[i].name.toLowerCase() == zonename.toLowerCase()) {
                var zonestatus = (zones[i].enabled == 2 ? "1" : "0");
                if (config.mqtt) {
                    mqttPub(config.mqttTopic + "/status/" + zonename + "/enabled", zonestatus, {});
                }

            resp = zones[i];
        }
    }
    return resp;
}

// START A ZONE
function _startZone(zonename) {
    var resp = {
        error: "zone not found"
    };
    for (var i in zones) {
        if (zones[i].name.toLowerCase() == zonename.toLowerCase() && zones[i].enabled === false) {
            log.debug("Starting zone " + zonename);
            connectedDevices[i] = airtunes.add(zones[i].host, {
                port: zones[i].port,
                volume: scaleSpeakerVolume(zones[i].volume)
            });
            zones[i].enabled = true;
                if (config.mqtt) {
                    mqttPub(config.mqttTopic + "/status/" + zonename + "/enabled", "1", {});
                }

            resp = zones[i];
        }
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
    return resp;
}

// STOP A ZONE
function _stopZone(zonename) {
    var resp = {
        error: "zone not found"
    };
    for (var i in zones) {
        if (zones[i].name.toLowerCase() == zonename.toLowerCase() && zones[i].enabled === true) {
            zones[i].enabled = false;
            if (connectedDevices[i]) {
                log.debug("Stopping zone " + zonename);
                connectedDevices[i].stop();
                if (config.mqtt) {
                    mqttPub(config.mqttTopic + "/status/" + zonename + "/enabled", "0", {});
                }
            }
            resp = zones[i];
        }
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
    return resp;
}


// SHOW A ZONE - ONLY USED IN WEBUI SO NO OUTPUT TO MQTT
function _showZone(zonename) {
    var resp = {
        error: "zone not found"
    };
    for (var i in zones) {
        if (zones[i].name.toLowerCase() == zonename.toLowerCase()) {
            zones[i].hidden = false;
            resp = zones[i];
        }
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
    return resp;
}


// HIDE A ZONE - ONLY USED IN WEBUI SO NO OUTPUT TO MQTT
function _hideZone(zonename) {
    var resp = {
        error: "zone not found"
    };
    for (var i in zones) {
        if (zones[i].name.toLowerCase() == zonename.toLowerCase()) {
            zones[i].hidden = true;
            resp = zones[i];
        }
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
    return resp;
}


// SET VOLUME (with master volume)
function _setVolume(zonename, volume) {
    var resp = {
        error: "zone not found"
    };
    log.info("Set volume requested for speaker " + zonename + " - set speaker volume to " + volume);
    for (var i in zones) {
        if (zones[i].name.toLowerCase() == zonename.toLowerCase()) {
            // Setting configured per-speaker volume
            zones[i].volume = volume;
            if (connectedDevices[i]) {
                // And adjusting the mastervolume of this speaker if it's active on the airtunes server
                log.info("Speaker active - scaling volume request with mastervolume to " + scaleSpeakerVolume(volume) + " for " + zonename);
                connectedDevices[i].setVolume(scaleSpeakerVolume(volume));
                if (config.mqtt) {
                    mqttPub(config.mqttTopic + "/status/" + zonename + "/volume", volume.toString(), {});
                }
            }
            else {
                log.info("Zone " + zonename + " not found - ignoring request");
            }
            resp = zones[i];
        }
    }
    config.zones = zones;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
    return volume;
}


function _getVolume(speaker) {
    var resp = {
        error: "zone not found"
    };
    log.info("Get volume called for " + speaker);
    for (var i in zones) {
        if (zones[i].name.toLowerCase() == speaker.toLowerCase()) {
            if (connectedDevices[i]) {
                log.info("Zone get volume called for " + speaker);
                var zonevol = connectedDevices[i].volume;
                if (config.mqtt) {
                    mqttPub(config.mqttTopic + "/status/" + speaker + "/volume", zonevol.toString(), {});
                }
            }
            else {
                log.info("Zone " + speaker + " not found - ignoring request");
            }
            resp = zones[i];
        }
    }
}

// If we change the master volume while speakers are replaying, we need to re-scale all the enabled zones.
// Input: None
// Output: None
// Action: Re-sets all speaker volumes based on requested speaker volume and the master volume
function _masterRescale() {
    // For all active speakers
    for (var i in zones) {
        if (zones[i].enabled) {
            // Re-scale the existing per-speaker volume with the new master volume
            connectedDevices[i].setVolume(scaleSpeakerVolume(zones[i].volume));
            log.info("Rescale volume for zone " + zones[i].name + " to " + scaleSpeakerVolume(zones[i].volume));
            if (config.mqtt) {
                // MQTT publish all new volumes to sync home assistant
                _getVolume(zones[i].name);
            }
        }
    }
    // MQTT publish new master volume for good measure
    _getMasterVolume();
 }

// input:  volume is -144 or (-30 to zero)
// output: config.mastervolume between 0 & 100
function _setMasterVolumeApple(volume)  {
    // TODO Check if volume is -144 or (30 to zero)
    var _volume = (parseInt(volume, 10));
    log.debug("Apple original master volume requested to change to " + _volume.toString());
    var _volumerescaled=parseAppleMasterVolume(_volume);
    log.debug("Changing master volume to " + _volumerescaled.toString());	

    // If OK THEN set master volume
    config.mastervolume = _volumerescaled;  // 0 to 100
    
    if (config.mqtt) {
        log.debug("Setting master volume to " + volume);
        mqttPub(config.mqttTopic + "/status/GLOBAL/volume", volume.toString(), {});
    }
    _masterRescale();
}

// input:  volume is 0 - 100
// output: config.mastervolume between 0 & 100
function _setMasterVolume(volume) {
    // TODO Check if volume is 0 - 100
    var _volume = (parseInt(volume, 10));
    log.debug("Master volume changed to " + _volume.toString());

    // If OK THEN set master volume
    config.mastervolume = _volume;  // 0 - 100
    
    if (config.mqtt) {
        log.debug("Setting master volume to " + volume);
        mqttPub(config.mqttTopic + "/status/GLOBAL/volume", volume.toString(), {});
    }
    _masterRescale();
}

// output: Publish  config.mastervolume between 0 & 100
function _getMasterVolume() {
    if (config.mqtt) {
        log.debug("Publishing master volume " + config.mastervolume);
        mqttPub(config.mqttTopic + "/status/GLOBAL/volume", config.mastervolume, {});
    }
}

// speaker is a string, the speakername
function _isSpeakerKnown(speaker) {
    // Check whether this message is about GLOBAL or a specific speaker which we know about 
    for (var i in zones) {
        if (zones[i].name.toLowerCase() == speaker.toLowerCase() || speaker.toLowerCase() == "GLOBAL".toLowerCase()) {
            // This is a known speaker - continue parsing
            return true;
        }
    }

    return false;
}

// msgtype is a string: get, set or status
function _isStatusMessage(msgtype) {
    if (msgtype.toLowerCase() == "status") {
        return true;
    }
    return false;
}

// speaker is a string, the speakername
function _isGlobalVolumeMessage(speaker) {
    if (speaker.toLowerCase() == "GLOBAL".toLowerCase()) {
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
